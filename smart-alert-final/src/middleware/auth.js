const jwt = require('jsonwebtoken');
const config = require('../../config');
const { getDb } = require('../models/database');
const logger = require('../utils/logger');

function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: 'Missing authorization token' });
  }

  try {
    const decoded = jwt.verify(token, config.auth.jwtSecret);
    const db = getDb();
    const user = db.prepare('SELECT id, username, display_name FROM users WHERE id = ?').get(decoded.userId);

    if (!user) {
      return res.status(401).json({ error: 'User not found' });
    }

    req.user = user;
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token expired' });
    }
    logger.warn('Invalid token', { error: err.message });
    return res.status(403).json({ error: 'Invalid token' });
  }
}

/**
 * Verify a WebSocket upgrade token (passed as query param ?token=...).
 * Returns the user object or null.
 */
function verifyWsToken(token) {
  if (!token) return null;
  try {
    const decoded = jwt.verify(token, config.auth.jwtSecret);
    const db = getDb();
    return db.prepare('SELECT id, username, display_name FROM users WHERE id = ?').get(decoded.userId);
  } catch {
    return null;
  }
}

module.exports = { authenticateToken, verifyWsToken };
