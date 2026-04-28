const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../models/database');
const { validate, schemas } = require('../middleware/validate');
const { authenticateToken } = require('../middleware/auth');
const config = require('../../config');
const logger = require('../utils/logger');

const router = express.Router();

// POST /auth/register
router.post('/register', validate(schemas.register), async (req, res, next) => {
  try {
    const { username, password, displayName } = req.body;
    const db = getDb();

    const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
    if (existing) {
      return res.status(409).json({ error: 'Username already taken' });
    }

    const hash = await bcrypt.hash(password, 12);
    const userId = uuidv4();
    db.prepare(`
      INSERT INTO users (id, username, password_hash, display_name)
      VALUES (?, ?, ?, ?)
    `).run(userId, username, hash, displayName || username);

    const token = jwt.sign({ userId }, config.auth.jwtSecret, { expiresIn: config.auth.jwtExpiresIn });

    logger.info('User registered', { userId, username });
    res.status(201).json({
      token,
      user: { id: userId, username, displayName: displayName || username },
    });
  } catch (err) {
    next(err);
  }
});

// POST /auth/login
router.post('/login', validate(schemas.login), async (req, res, next) => {
  try {
    const { username, password } = req.body;
    const db = getDb();

    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = jwt.sign({ userId: user.id }, config.auth.jwtSecret, { expiresIn: config.auth.jwtExpiresIn });

    logger.info('User logged in', { userId: user.id, username });
    res.json({
      token,
      user: { id: user.id, username: user.username, displayName: user.display_name },
    });
  } catch (err) {
    next(err);
  }
});

// GET /auth/me
router.get('/me', authenticateToken, (req, res) => {
  res.json({ user: req.user });
});

module.exports = router;
