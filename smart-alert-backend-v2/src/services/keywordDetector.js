const { EventEmitter } = require('events');
const config = require('../../config');
const logger = require('../utils/logger');

/**
 * KeywordDetector
 *
 * Takes transcribed text (from the client's Web Speech API or any STT source)
 * and checks it against registered keywords.  Supports three match modes:
 *
 *   'exact'    — full word boundary match only
 *   'contains' — substring match (default)
 *   'prefix'   — word must start with keyword
 *
 * Also implements:
 *   - Per-session alert cooldown (prevents rapid-fire duplicates)
 *   - Confidence scoring (edit-distance fuzzy fallback)
 *   - Rate limiting (max alerts per minute)
 */
class KeywordDetector extends EventEmitter {
  constructor(options = {}) {
    super();
    this.cooldownMs = options.cooldownMs || config.alerts.cooldownMs;
    this.maxPerMinute = options.maxPerMinute || config.alerts.maxPerMinute;

    // Map<sessionId, { keywords: Keyword[], lastAlertTs: number, alertsThisMinute: number, windowStart: number }>
    this._sessions = new Map();
  }

  // ─── Session Management ───────────────────────────────────────────────────

  registerSession(sessionId, keywords = []) {
    this._sessions.set(sessionId, {
      keywords: keywords.map(k => this._normalizeKeyword(k)),
      lastAlertTs: 0,
      alertsThisMinute: 0,
      windowStart: Date.now(),
    });
    logger.debug('KeywordDetector: session registered', { sessionId, keywordCount: keywords.length });
  }

  updateKeywords(sessionId, keywords) {
    const session = this._sessions.get(sessionId);
    if (!session) {
      this.registerSession(sessionId, keywords);
      return;
    }
    session.keywords = keywords.map(k => this._normalizeKeyword(k));
    logger.debug('KeywordDetector: keywords updated', { sessionId, keywordCount: keywords.length });
  }

  removeSession(sessionId) {
    this._sessions.delete(sessionId);
  }

  // ─── Detection ────────────────────────────────────────────────────────────

  /**
   * Analyze a transcript string for the given session.
   * Emits 'alert' event for each matching keyword (subject to rate limits).
   *
   * @param {string} sessionId
   * @param {string} transcript  — raw text from STT
   * @param {Object} meta        — { confidence, noiseLevel, signalLevel, audioDurationMs }
   * @returns {DetectionResult[]}
   */
  analyze(sessionId, transcript, meta = {}) {
    const session = this._sessions.get(sessionId);
    if (!session || !transcript) return [];

    const now = Date.now();
    this._refreshRateWindow(session, now);

    // Global session cooldown
    if (now - session.lastAlertTs < this.cooldownMs) return [];

    // Rate limit
    if (session.alertsThisMinute >= this.maxPerMinute) {
      logger.warn('KeywordDetector: rate limit hit', { sessionId });
      return [];
    }

    const results = [];
    const normalizedTranscript = transcript.toLowerCase().trim();

    for (const kw of session.keywords) {
      const match = this._matchKeyword(normalizedTranscript, kw);
      if (match) {
        results.push(match);
        break; // one alert per analyze() call to avoid flooding
      }
    }

    if (results.length > 0) {
      session.lastAlertTs = now;
      session.alertsThisMinute++;

      const result = results[0];
      const alertPayload = {
        sessionId,
        keywordId: result.keyword.id,
        matchedWord: result.keyword.word,
        transcript,
        confidence: result.confidence,
        ...meta,
        triggeredAt: now,
      };

      this.emit('alert', alertPayload);
      logger.info('Keyword detected', { sessionId, matchedWord: result.keyword.word, confidence: result.confidence });
    }

    return results;
  }

  // ─── Matching Logic ───────────────────────────────────────────────────────

  _matchKeyword(transcript, kw) {
    const word = kw.caseSensitive ? kw.word : kw.word.toLowerCase();
    const text = kw.caseSensitive ? transcript : transcript.toLowerCase();

    switch (kw.matchMode) {
      case 'exact': {
        const regex = new RegExp(`\\b${this._escapeRegex(word)}\\b`);
        if (regex.test(text)) {
          return { keyword: kw, confidence: 1.0 };
        }
        break;
      }
      case 'prefix': {
        const regex = new RegExp(`\\b${this._escapeRegex(word)}`);
        if (regex.test(text)) {
          return { keyword: kw, confidence: 0.95 };
        }
        break;
      }
      case 'contains':
      default: {
        if (text.includes(word)) {
          return { keyword: kw, confidence: 1.0 };
        }
        // Fuzzy fallback: edit distance ≤ 1 for words of length ≥ 4
        if (word.length >= 4) {
          const words = text.split(/\s+/);
          for (const w of words) {
            const dist = this._editDistance(w, word);
            if (dist <= 1) {
              return { keyword: kw, confidence: 0.85 };
            }
          }
        }
        break;
      }
    }
    return null;
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────

  _normalizeKeyword(kw) {
    if (typeof kw === 'string') {
      return { id: null, word: kw.trim(), matchMode: 'contains', caseSensitive: false };
    }
    return {
      id: kw.id || null,
      word: (kw.word || '').trim(),
      matchMode: kw.match_mode || kw.matchMode || 'contains',
      caseSensitive: Boolean(kw.case_sensitive || kw.caseSensitive),
    };
  }

  _refreshRateWindow(session, now) {
    if (now - session.windowStart > 60000) {
      session.alertsThisMinute = 0;
      session.windowStart = now;
    }
  }

  _escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  /**
   * Wagner–Fischer edit distance (Levenshtein).
   * Used for fuzzy keyword matching.
   */
  _editDistance(a, b) {
    const m = a.length, n = b.length;
    if (m === 0) return n;
    if (n === 0) return m;

    const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
    for (let j = 0; j <= n; j++) dp[0][j] = j;

    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        if (a[i - 1] === b[j - 1]) {
          dp[i][j] = dp[i - 1][j - 1];
        } else {
          dp[i][j] = 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
        }
      }
    }
    return dp[m][n];
  }
}

module.exports = KeywordDetector;
