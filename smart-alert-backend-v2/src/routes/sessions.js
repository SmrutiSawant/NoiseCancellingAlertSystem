const express = require('express');
const { authenticateToken } = require('../middleware/auth');
const { validate, schemas } = require('../middleware/validate');
const sessionManager = require('../services/sessionManager');
const logger = require('../utils/logger');

const router = express.Router();
router.use(authenticateToken);

// ─── Sessions ─────────────────────────────────────────────────────────────────

// GET /sessions — list user's sessions
router.get('/', (req, res, next) => {
  try {
    const sessions = sessionManager.getUserSessions(req.user.id);
    res.json({ sessions });
  } catch (err) {
    next(err);
  }
});

// POST /sessions — start a new session
router.post('/', validate(schemas.createSession), (req, res, next) => {
  try {
    const session = sessionManager.startSession(req.user.id, req.body);
    res.status(201).json({ session });
  } catch (err) {
    next(err);
  }
});

// GET /sessions/:id
router.get('/:id', (req, res, next) => {
  try {
    const session = sessionManager.getSession(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    if (session.user_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });
    res.json({ session });
  } catch (err) {
    next(err);
  }
});

// DELETE /sessions/:id — stop and close session
router.delete('/:id', (req, res, next) => {
  try {
    const session = sessionManager.getSession(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    if (session.user_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });

    sessionManager.stopSession(req.params.id);
    res.json({ stopped: true });
  } catch (err) {
    next(err);
  }
});

// ─── Keywords ────────────────────────────────────────────────────────────────

// POST /sessions/:id/keywords
router.post('/:id/keywords', validate(schemas.addKeyword), (req, res, next) => {
  try {
    const session = sessionManager.getSession(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    if (session.user_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });

    const { word, matchMode, caseSensitive } = req.body;
    const keyword = sessionManager.addKeyword(req.params.id, word, matchMode, caseSensitive);
    res.status(201).json({ keyword });
  } catch (err) {
    next(err);
  }
});

// DELETE /sessions/:id/keywords/:kwId
router.delete('/:id/keywords/:kwId', (req, res, next) => {
  try {
    const session = sessionManager.getSession(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    if (session.user_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });

    const removed = sessionManager.removeKeyword(req.params.id, req.params.kwId);
    if (!removed) return res.status(404).json({ error: 'Keyword not found' });
    res.json({ removed: true });
  } catch (err) {
    next(err);
  }
});

// ─── Transcript Analysis ──────────────────────────────────────────────────────

// POST /sessions/:id/transcript — submit STT transcript for keyword analysis
router.post('/:id/transcript', validate(schemas.transcript), (req, res, next) => {
  try {
    const session = sessionManager.getSession(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    if (session.user_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });

    const { transcript, confidence, noiseLevel, signalLevel, audioDurationMs, isFinal } = req.body;

    let detections = [];
    if (isFinal) {
      detections = sessionManager.analyzeTranscript(req.params.id, transcript, {
        confidence, noiseLevel, signalLevel, audioDurationMs,
      });
    }

    res.json({
      analyzed: isFinal,
      detectionsCount: detections.length,
      detections: detections.map(d => ({ matchedWord: d.keyword.word, confidence: d.confidence })),
    });
  } catch (err) {
    next(err);
  }
});

// ─── Alerts ──────────────────────────────────────────────────────────────────

// GET /sessions/:id/alerts
router.get('/:id/alerts', validate(schemas.alertsQuery, 'query'), (req, res, next) => {
  try {
    const session = sessionManager.getSession(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    if (session.user_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });

    const alerts = sessionManager.getAlerts(req.params.id, req.query);
    res.json({ alerts });
  } catch (err) {
    next(err);
  }
});

// PATCH /sessions/:id/alerts/:alertId/acknowledge
router.patch('/:id/alerts/:alertId/acknowledge', (req, res, next) => {
  try {
    const session = sessionManager.getSession(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    if (session.user_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });

    const acked = sessionManager.acknowledgeAlert(req.params.id, req.params.alertId);
    if (!acked) return res.status(404).json({ error: 'Alert not found or already acknowledged' });
    res.json({ acknowledged: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
