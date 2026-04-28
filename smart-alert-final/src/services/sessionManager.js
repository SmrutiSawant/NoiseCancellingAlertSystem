const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../models/database');
const AudioProcessor = require('./audioProcessor');
const KeywordDetector = require('./keywordDetector');
const logger = require('../utils/logger');

/**
 * SessionManager
 *
 * Owns the lifecycle of all active alert sessions:
 *   - Creates / resumes / stops sessions
 *   - Wires AudioProcessor → KeywordDetector
 *   - Persists alerts and periodic noise stats to the database
 *   - Maintains an in-memory map of active session state
 */
class SessionManager {
  constructor() {
    // Map<sessionId, ActiveSession>
    this._active = new Map();
    this.keywordDetector = new KeywordDetector();

    this.keywordDetector.on('alert', (payload) => this._persistAlert(payload));
  }

  // ─── Session Lifecycle ────────────────────────────────────────────────────

  /**
   * Start or resume a session for userId.
   * Returns the session record.
   */
  startSession(userId, options = {}) {
    const db = getDb();
    const sessionId = uuidv4();

    const stmt = db.prepare(`
      INSERT INTO sessions (id, user_id, name, sensitivity, noise_reduction_strength, vad_mode, is_active)
      VALUES (?, ?, ?, ?, ?, ?, 1)
    `);
    stmt.run(
      sessionId,
      userId,
      options.name || 'Session ' + new Date().toLocaleTimeString(),
      options.sensitivity ?? 7,
      options.noiseReductionStrength ?? 0.75,
      options.vadMode ?? 3,
    );

    const keywords = options.keywords || [];
    this._insertKeywords(sessionId, keywords);

    const processor = new AudioProcessor({
      sampleRate: options.sampleRate,
      noiseReductionStrength: options.noiseReductionStrength,
      vadMode: options.vadMode,
    });

    processor.on('stats', (stats) => this._persistNoiseStats(sessionId, stats));
    processor.on('speech', () => logger.debug('speech onset', { sessionId }));

    this.keywordDetector.registerSession(
      sessionId,
      this._loadKeywords(sessionId),
    );

    this._active.set(sessionId, {
      sessionId,
      userId,
      processor,
      startedAt: Date.now(),
      wsClients: new Set(),
    });

    logger.info('Session started', { sessionId, userId });
    return this.getSession(sessionId);
  }

  stopSession(sessionId) {
    const active = this._active.get(sessionId);
    if (!active) return false;

    active.processor.reset();
    this.keywordDetector.removeSession(sessionId);
    this._active.delete(sessionId);

    const db = getDb();
    db.prepare('UPDATE sessions SET is_active = 0, updated_at = unixepoch() WHERE id = ?').run(sessionId);

    logger.info('Session stopped', { sessionId });
    return true;
  }

  getSession(sessionId) {
    const db = getDb();
    const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId);
    if (!session) return null;
    const keywords = this._loadKeywords(sessionId);
    return { ...session, keywords, isActive: Boolean(session.is_active) };
  }

  getUserSessions(userId) {
    const db = getDb();
    return db.prepare('SELECT * FROM sessions WHERE user_id = ? ORDER BY created_at DESC').all(userId);
  }

  // ─── Audio Processing ────────────────────────────────────────────────────

  /**
   * Push a raw PCM chunk into the session's AudioProcessor.
   * @param {string} sessionId
   * @param {Buffer} pcmBuffer  — Int16 LE PCM
   */
  processAudio(sessionId, pcmBuffer) {
    const active = this._active.get(sessionId);
    if (!active) throw new Error(`No active session: ${sessionId}`);
    active.processor.push(pcmBuffer);
  }

  /**
   * Analyze a transcript from the client's STT engine.
   */
  analyzeTranscript(sessionId, transcript, meta = {}) {
    return this.keywordDetector.analyze(sessionId, transcript, meta);
  }

  // ─── Keywords ────────────────────────────────────────────────────────────

  addKeyword(sessionId, word, matchMode = 'contains', caseSensitive = false) {
    const db = getDb();
    const id = uuidv4();
    db.prepare(`
      INSERT OR IGNORE INTO keywords (id, session_id, word, match_mode, case_sensitive)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, sessionId, word.trim(), matchMode, caseSensitive ? 1 : 0);

    this.keywordDetector.updateKeywords(sessionId, this._loadKeywords(sessionId));
    return db.prepare('SELECT * FROM keywords WHERE id = ?').get(id);
  }

  removeKeyword(sessionId, keywordId) {
    const db = getDb();
    const info = db.prepare('DELETE FROM keywords WHERE id = ? AND session_id = ?').run(keywordId, sessionId);
    if (info.changes > 0) {
      this.keywordDetector.updateKeywords(sessionId, this._loadKeywords(sessionId));
    }
    return info.changes > 0;
  }

  // ─── Alerts ──────────────────────────────────────────────────────────────

  getAlerts(sessionId, { limit = 50, offset = 0, since } = {}) {
    const db = getDb();
    let query = 'SELECT * FROM alerts WHERE session_id = ?';
    const params = [sessionId];
    if (since) { query += ' AND triggered_at >= ?'; params.push(since); }
    query += ' ORDER BY triggered_at DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);
    return db.prepare(query).all(...params);
  }

  acknowledgeAlert(sessionId, alertId) {
    const db = getDb();
    const info = db.prepare(`
      UPDATE alerts SET acknowledged_at = unixepoch('subsec') * 1000
      WHERE id = ? AND session_id = ? AND acknowledged_at IS NULL
    `).run(alertId, sessionId);
    return info.changes > 0;
  }

  // ─── WebSocket Client Tracking ───────────────────────────────────────────

  registerWsClient(sessionId, ws) {
    const active = this._active.get(sessionId);
    if (active) active.wsClients.add(ws);
  }

  unregisterWsClient(sessionId, ws) {
    const active = this._active.get(sessionId);
    if (active) active.wsClients.delete(ws);
  }

  broadcastToSession(sessionId, message) {
    const active = this._active.get(sessionId);
    if (!active) return;
    const payload = JSON.stringify(message);
    for (const ws of active.wsClients) {
      if (ws.readyState === 1) ws.send(payload);
    }
  }

  // ─── Persistence ─────────────────────────────────────────────────────────

  _persistAlert(payload) {
    const db = getDb();
    const id = uuidv4();
    db.prepare(`
      INSERT INTO alerts
        (id, session_id, keyword_id, matched_word, transcript, confidence,
         noise_level, signal_level, audio_duration_ms, triggered_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      payload.sessionId,
      payload.keywordId || null,
      payload.matchedWord,
      payload.transcript || null,
      payload.confidence || null,
      payload.noiseLevel || null,
      payload.signalLevel || null,
      payload.audioDurationMs || null,
      payload.triggeredAt,
    );

    this.broadcastToSession(payload.sessionId, {
      type: 'alert',
      alertId: id,
      ...payload,
    });
    logger.info('Alert persisted', { alertId: id, sessionId: payload.sessionId });
  }

  _persistNoiseStats(sessionId, stats) {
    const db = getDb();
    db.prepare(`
      INSERT INTO noise_stats
        (id, session_id, avg_noise_db, peak_noise_db, avg_signal_db,
         vad_speech_frames, vad_noise_frames, alerts_triggered)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      uuidv4(),
      sessionId,
      stats.avgNoiseDb,
      stats.peakNoiseDb,
      stats.avgSignalDb,
      stats.speechFrames,
      stats.silenceFrames,
      0,
    );
  }

  _insertKeywords(sessionId, keywords) {
    if (!keywords || keywords.length === 0) return;
    const db = getDb();
    for (const kw of keywords) {
      const word = typeof kw === 'string' ? kw : kw.word;
      const matchMode = (typeof kw === 'object' && kw.matchMode) ? kw.matchMode : 'contains';
      const caseSensitive = (typeof kw === 'object' && kw.caseSensitive) ? 1 : 0;
      try {
        db.run(
          'INSERT INTO keywords (id, session_id, word, match_mode, case_sensitive) VALUES (?, ?, ?, ?, ?)',
          [require('uuid').v4(), sessionId, word.trim(), matchMode, caseSensitive]
        );
      } catch(e) {
        if (!e.message.includes('UNIQUE')) throw e;
      }
    }
  }

  _loadKeywords(sessionId) {
    return getDb().prepare('SELECT * FROM keywords WHERE session_id = ?').all(sessionId);
  }
}

// Singleton
module.exports = new SessionManager();
