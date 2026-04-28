const { EventEmitter } = require('events');
const config = require('../../config');
const logger = require('../utils/logger');

/**
 * AudioProcessor
 *
 * Processes raw PCM audio frames streamed from the browser via WebSocket.
 * Pipeline:
 *   1. Pre-emphasis filter        — boost high frequencies before analysis
 *   2. Framing                    — split stream into overlapping frames
 *   3. Windowing (Hamming)        — reduce spectral leakage
 *   4. FFT / spectral analysis    — compute frequency magnitudes
 *   5. Noise estimation           — running min-statistics noise floor estimate
 *   6. Spectral subtraction       — suppress estimated noise from spectrum
 *   7. VAD (energy + ZCR)         — detect speech vs noise frames
 *   8. Emit events                — 'frame', 'speech', 'silence', 'stats'
 */
class AudioProcessor extends EventEmitter {
  constructor(options = {}) {
    super();
    this.sampleRate = options.sampleRate || config.audio.sampleRate;
    this.frameSize = options.frameSize || 512;
    this.hopSize = options.hopSize || 256;
    this.noiseReductionStrength = options.noiseReductionStrength || config.noise.reductionStrength;
    this.vadMode = options.vadMode || config.audio.vadMode;

    // Pre-emphasis filter coefficient (boost frequencies > ~1 kHz)
    this.preEmphCoeff = 0.97;

    // Noise estimator state (min-statistics over ~1 second of frames)
    this.noiseEstimateFrames = Math.ceil(this.sampleRate / this.hopSize);
    this.noiseSpectrumBuffer = [];
    this.noiseSpectrum = null;

    // Input sample buffer
    this._buffer = Buffer.alloc(0);
    this._prevSample = 0;

    // Stats accumulators
    this._stats = this._freshStats();

    // VAD state
    this._consecutiveSpeechFrames = 0;
    this._consecutiveSilenceFrames = 0;
    this._isSpeech = false;

    // VAD thresholds scale with vadMode (0=permissive, 3=aggressive)
    this._vadEnergyMultiplier = 1 + (this.vadMode * 0.5); // 1.0 – 2.5
    this._hangoverFrames = Math.max(4, 12 - this.vadMode * 2);

    logger.debug('AudioProcessor initialized', {
      sampleRate: this.sampleRate,
      frameSize: this.frameSize,
      vadMode: this.vadMode,
      noiseReductionStrength: this.noiseReductionStrength,
    });
  }

  // ─── Public API ──────────────────────────────────────────────────────────────

  /**
   * Feed raw PCM Int16 Buffer into the processor.
   * Frames are extracted and processed as they become available.
   */
  push(pcmBuffer) {
    if (!Buffer.isBuffer(pcmBuffer)) {
      pcmBuffer = Buffer.from(pcmBuffer);
    }
    this._buffer = Buffer.concat([this._buffer, pcmBuffer]);
    this._processBuffer();
  }

  reset() {
    this._buffer = Buffer.alloc(0);
    this._prevSample = 0;
    this.noiseSpectrumBuffer = [];
    this.noiseSpectrum = null;
    this._stats = this._freshStats();
    this._consecutiveSpeechFrames = 0;
    this._consecutiveSilenceFrames = 0;
    this._isSpeech = false;
    logger.debug('AudioProcessor reset');
  }

  getStats() {
    const s = this._stats;
    const totalFrames = s.speechFrames + s.silenceFrames || 1;
    return {
      speechFrames: s.speechFrames,
      silenceFrames: s.silenceFrames,
      speechRatio: +(s.speechFrames / totalFrames).toFixed(3),
      avgNoiseDb: s.noiseDbSum > 0 ? +(s.noiseDbSum / s.frameCount).toFixed(2) : null,
      peakNoiseDb: s.peakNoiseDb,
      avgSignalDb: s.signalDbSum > 0 ? +(s.signalDbSum / s.speechFrames || 0).toFixed(2) : null,
      frameCount: s.frameCount,
    };
  }

  // ─── Internal Processing ─────────────────────────────────────────────────────

  _processBuffer() {
    const bytesPerFrame = this.frameSize * 2; // Int16 = 2 bytes per sample
    const bytesPerHop = this.hopSize * 2;

    while (this._buffer.length >= bytesPerFrame) {
      const frameBytes = this._buffer.slice(0, bytesPerFrame);
      this._buffer = this._buffer.slice(bytesPerHop);

      const samples = this._bytesToFloat32(frameBytes);
      const emphasized = this._preEmphasis(samples);
      const windowed = this._applyHamming(emphasized);
      const spectrum = this._fft(windowed);
      const magnitudes = this._magnitudes(spectrum);

      this._updateNoiseEstimate(magnitudes);
      const cleanMagnitudes = this._spectralSubtraction(magnitudes);
      const vadResult = this._vad(emphasized, cleanMagnitudes);

      this._updateStats(magnitudes, cleanMagnitudes, vadResult);
      this._handleVadTransitions(vadResult, cleanMagnitudes);

      this.emit('frame', {
        magnitudes: cleanMagnitudes,
        rawMagnitudes: magnitudes,
        isSpeech: vadResult.isSpeech,
        energy: vadResult.energy,
        zcr: vadResult.zcr,
        noiseDb: this._toDb(this._rms(magnitudes)),
        signalDb: this._toDb(this._rms(cleanMagnitudes)),
      });
    }
  }

  _bytesToFloat32(buf) {
    const samples = new Float32Array(buf.length / 2);
    for (let i = 0; i < samples.length; i++) {
      const s = buf.readInt16LE(i * 2);
      samples[i] = s / 32768.0;
    }
    return samples;
  }

  _preEmphasis(samples) {
    const out = new Float32Array(samples.length);
    out[0] = samples[0] - this.preEmphCoeff * this._prevSample;
    for (let i = 1; i < samples.length; i++) {
      out[i] = samples[i] - this.preEmphCoeff * samples[i - 1];
    }
    this._prevSample = samples[samples.length - 1];
    return out;
  }

  _applyHamming(samples) {
    const out = new Float32Array(samples.length);
    const N = samples.length;
    for (let i = 0; i < N; i++) {
      out[i] = samples[i] * (0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (N - 1)));
    }
    return out;
  }

  /**
   * Radix-2 Cooley–Tukey FFT (real input → complex output as [re, im, re, im, ...])
   * Pads or truncates to next power of 2.
   */
  _fft(samples) {
    const n = this._nextPow2(samples.length);
    const real = new Float32Array(n);
    const imag = new Float32Array(n);
    for (let i = 0; i < samples.length; i++) real[i] = samples[i];

    // Bit-reversal permutation
    let j = 0;
    for (let i = 1; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        [real[i], real[j]] = [real[j], real[i]];
        [imag[i], imag[j]] = [imag[j], imag[i]];
      }
    }

    // Butterfly computation
    for (let len = 2; len <= n; len <<= 1) {
      const ang = (-2 * Math.PI) / len;
      const wRe = Math.cos(ang);
      const wIm = Math.sin(ang);
      for (let i = 0; i < n; i += len) {
        let curRe = 1, curIm = 0;
        for (let k = 0; k < len / 2; k++) {
          const uRe = real[i + k];
          const uIm = imag[i + k];
          const vRe = real[i + k + len / 2] * curRe - imag[i + k + len / 2] * curIm;
          const vIm = real[i + k + len / 2] * curIm + imag[i + k + len / 2] * curRe;
          real[i + k] = uRe + vRe;
          imag[i + k] = uIm + vIm;
          real[i + k + len / 2] = uRe - vRe;
          imag[i + k + len / 2] = uIm - vIm;
          const nextRe = curRe * wRe - curIm * wIm;
          curIm = curRe * wIm + curIm * wRe;
          curRe = nextRe;
        }
      }
    }

    return { real, imag, n };
  }

  _magnitudes({ real, imag, n }) {
    const half = n / 2;
    const mags = new Float32Array(half);
    for (let i = 0; i < half; i++) {
      mags[i] = Math.sqrt(real[i] * real[i] + imag[i] * imag[i]) / n;
    }
    return mags;
  }

  /**
   * Running minimum-statistics noise floor estimator.
   * Maintains a rolling buffer of spectra; uses element-wise min as floor.
   */
  _updateNoiseEstimate(magnitudes) {
    this.noiseSpectrumBuffer.push(new Float32Array(magnitudes));
    if (this.noiseSpectrumBuffer.length > this.noiseEstimateFrames) {
      this.noiseSpectrumBuffer.shift();
    }

    if (this.noiseSpectrumBuffer.length < 3) return;

    const n = magnitudes.length;
    const estimate = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let min = Infinity;
      for (const frame of this.noiseSpectrumBuffer) {
        if (frame[i] < min) min = frame[i];
      }
      estimate[i] = min;
    }
    this.noiseSpectrum = estimate;
  }

  /**
   * Spectral subtraction: clean[i] = max(|X[i]| - α * noise[i], β * |X[i]|)
   * α = reductionStrength, β = spectral floor (0.02) to avoid musical noise
   */
  _spectralSubtraction(magnitudes) {
    if (!this.noiseSpectrum) return magnitudes;

    const alpha = this.noiseReductionStrength;
    const beta = 0.02;
    const out = new Float32Array(magnitudes.length);

    for (let i = 0; i < magnitudes.length; i++) {
      const subtracted = magnitudes[i] - alpha * this.noiseSpectrum[i];
      out[i] = Math.max(subtracted, beta * magnitudes[i]);
    }
    return out;
  }

  /**
   * VAD using energy + zero-crossing rate.
   * Returns { isSpeech, energy, zcr }
   */
  _vad(samples, cleanMagnitudes) {
    const energy = this._rms(samples);
    const zcr = this._zeroCrossingRate(samples);

    const noiseEnergy = this.noiseSpectrum ? this._rms(this.noiseSpectrum) : 0;
    const dynamicThreshold = Math.max(0.01, noiseEnergy * this._vadEnergyMultiplier);

    // Primary energy gate
    const energyVoiced = energy > dynamicThreshold;

    // ZCR heuristic: voiced speech typically 50–3000 Hz → ZCR 0.01–0.15
    const zcrVoiced = zcr > 0.01 && zcr < 0.25;

    // Spectral energy in voice band (300–3400 Hz)
    const voiceBandEnergy = this._bandEnergy(cleanMagnitudes, 300, 3400);
    const bandVoiced = voiceBandEnergy > dynamicThreshold * 0.5;

    const isSpeech = energyVoiced && (zcrVoiced || bandVoiced);

    return { isSpeech, energy, zcr, voiceBandEnergy };
  }

  _handleVadTransitions(vadResult, cleanMagnitudes) {
    if (vadResult.isSpeech) {
      this._consecutiveSpeechFrames++;
      this._consecutiveSilenceFrames = 0;
    } else {
      this._consecutiveSilenceFrames++;
      this._consecutiveSpeechFrames = 0;
    }

    // Onset: 2 consecutive speech frames
    if (!this._isSpeech && this._consecutiveSpeechFrames >= 2) {
      this._isSpeech = true;
      this.emit('speech', { magnitudes: cleanMagnitudes });
    }

    // Offset: hangover frames of silence
    if (this._isSpeech && this._consecutiveSilenceFrames >= this._hangoverFrames) {
      this._isSpeech = false;
      this.emit('silence', {});
    }
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────────

  _rms(arr) {
    let sum = 0;
    for (let i = 0; i < arr.length; i++) sum += arr[i] * arr[i];
    return Math.sqrt(sum / arr.length);
  }

  _zeroCrossingRate(samples) {
    let crossings = 0;
    for (let i = 1; i < samples.length; i++) {
      if ((samples[i] >= 0) !== (samples[i - 1] >= 0)) crossings++;
    }
    return crossings / samples.length;
  }

  _bandEnergy(magnitudes, lowHz, highHz) {
    const binSize = this.sampleRate / (magnitudes.length * 2);
    const lowBin = Math.max(0, Math.floor(lowHz / binSize));
    const highBin = Math.min(magnitudes.length - 1, Math.ceil(highHz / binSize));
    let sum = 0;
    for (let i = lowBin; i <= highBin; i++) sum += magnitudes[i] * magnitudes[i];
    return Math.sqrt(sum / (highBin - lowBin + 1));
  }

  _toDb(linearAmp) {
    if (linearAmp <= 0) return config.noise.floorDb;
    return Math.max(config.noise.floorDb, 20 * Math.log10(linearAmp));
  }

  _nextPow2(n) {
    let p = 1;
    while (p < n) p <<= 1;
    return p;
  }

  _updateStats(rawMags, cleanMags, vadResult) {
    this._stats.frameCount++;
    const noiseDb = this._toDb(this._rms(rawMags));
    const signalDb = this._toDb(this._rms(cleanMags));
    this._stats.noiseDbSum += noiseDb;
    if (noiseDb > this._stats.peakNoiseDb) this._stats.peakNoiseDb = noiseDb;
    if (vadResult.isSpeech) {
      this._stats.speechFrames++;
      this._stats.signalDbSum += signalDb;
    } else {
      this._stats.silenceFrames++;
    }

    // Emit stats every ~1 second
    if (this._stats.frameCount % this.noiseEstimateFrames === 0) {
      this.emit('stats', this.getStats());
    }
  }

  _freshStats() {
    return {
      frameCount: 0,
      speechFrames: 0,
      silenceFrames: 0,
      noiseDbSum: 0,
      peakNoiseDb: -Infinity,
      signalDbSum: 0,
    };
  }
}

module.exports = AudioProcessor;
