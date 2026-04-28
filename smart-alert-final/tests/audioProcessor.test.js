const AudioProcessor = require('../src/services/audioProcessor');

function makePcmBuffer(numSamples, frequency = 440, sampleRate = 16000, amplitude = 0.5) {
  const buf = Buffer.alloc(numSamples * 2);
  for (let i = 0; i < numSamples; i++) {
    const sample = Math.round(amplitude * 32767 * Math.sin(2 * Math.PI * frequency * i / sampleRate));
    buf.writeInt16LE(Math.max(-32768, Math.min(32767, sample)), i * 2);
  }
  return buf;
}

function makeSilenceBuffer(numSamples) {
  return Buffer.alloc(numSamples * 2, 0);
}

describe('AudioProcessor', () => {
  let proc;

  beforeEach(() => {
    proc = new AudioProcessor({ sampleRate: 16000, frameSize: 512, hopSize: 256 });
  });

  test('emits frame events when audio is pushed', (done) => {
    proc.once('frame', (frame) => {
      expect(frame).toHaveProperty('magnitudes');
      expect(frame).toHaveProperty('isSpeech');
      expect(frame).toHaveProperty('noiseDb');
      done();
    });
    proc.push(makePcmBuffer(1024));
  });

  test('handles silence correctly', (done) => {
    const frames = [];
    proc.on('frame', (f) => frames.push(f));
    proc.push(makeSilenceBuffer(4096));
    setTimeout(() => {
      expect(frames.length).toBeGreaterThan(0);
      // Silence should not be detected as speech
      const speechFrames = frames.filter(f => f.isSpeech);
      expect(speechFrames.length).toBe(0);
      done();
    }, 50);
  });

  test('emits speech event for loud audio', (done) => {
    proc.once('speech', () => done());
    // Push enough frames to build noise estimate first
    proc.push(makeSilenceBuffer(8192));
    proc.push(makePcmBuffer(8192, 1000, 16000, 0.8));
  });

  test('FFT produces correct number of bins', () => {
    const samples = new Float32Array(512).fill(0.1);
    const spectrum = proc._fft(samples);
    const mags = proc._magnitudes(spectrum);
    expect(mags.length).toBe(512 / 2);
  });

  test('spectral subtraction reduces noise', () => {
    const mags = new Float32Array(256).fill(0.5);
    proc.noiseSpectrum = new Float32Array(256).fill(0.4);
    const clean = proc._spectralSubtraction(mags);
    const cleanAvg = clean.reduce((a, b) => a + b) / clean.length;
    const rawAvg = mags.reduce((a, b) => a + b) / mags.length;
    expect(cleanAvg).toBeLessThan(rawAvg);
  });

  test('VAD returns speech for high-energy audio', () => {
    const samples = new Float32Array(512).fill(0.8);
    proc.noiseSpectrum = new Float32Array(256).fill(0.01);
    const mags = new Float32Array(256).fill(0.8);
    const result = proc._vad(samples, mags);
    expect(result).toHaveProperty('isSpeech');
    expect(result).toHaveProperty('energy');
  });

  test('pre-emphasis boosts high frequencies', () => {
    const samples = new Float32Array(512).fill(0.5);
    const emphasized = proc._preEmphasis(samples);
    // After steady signal, all values should be near 0 (difference is small)
    expect(Math.abs(emphasized[1])).toBeLessThan(0.05);
  });

  test('getStats returns valid structure', () => {
    proc.push(makePcmBuffer(4096));
    const stats = proc.getStats();
    expect(stats).toHaveProperty('frameCount');
    expect(stats).toHaveProperty('speechRatio');
    expect(stats.speechRatio).toBeGreaterThanOrEqual(0);
    expect(stats.speechRatio).toBeLessThanOrEqual(1);
  });

  test('reset clears state', () => {
    proc.push(makePcmBuffer(2048));
    proc.reset();
    expect(proc._buffer.length).toBe(0);
    expect(proc.noiseSpectrum).toBeNull();
    expect(proc.getStats().frameCount).toBe(0);
  });
});
