const http = require('http');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { initDb, closeDb } = require('./models/database');
const { createWsServer } = require('./services/wsServer');
const authRoutes = require('./routes/auth');
const sessionRoutes = require('./routes/sessions');
const { errorHandler, notFound } = require('./middleware/errorHandler');
const config = require('../config');
const logger = require('./utils/logger');

const app = express();

// ─── Security & Parsing ───────────────────────────────────────────────────────
app.use(helmet({
  crossOriginEmbedderPolicy: false,
  contentSecurityPolicy: false,
}));

app.use(cors({
  origin: config.server.env === 'production'
    ? process.env.ALLOWED_ORIGINS?.split(',') || []
    : '*',
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

// ─── Rate Limiting ────────────────────────────────────────────────────────────
const limiter = rateLimit({
  windowMs: config.rateLimit.windowMs,
  max: config.rateLimit.maxRequests,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please slow down.' },
});
app.use('/api/', limiter);

// ─── Health Check ─────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    timestamp: Date.now(),
    version: require('../package.json').version,
  });
});

// ─── Routes ───────────────────────────────────────────────────────────────────
app.use('/api/auth', authRoutes);
app.use('/api/sessions', sessionRoutes);

// ─── 404 + Error handlers ─────────────────────────────────────────────────────
app.use(notFound);
app.use(errorHandler);

// ─── Bootstrap ───────────────────────────────────────────────────────────────
async function start() {
  await initDb();

  const httpServer = http.createServer(app);
  createWsServer(httpServer);

  httpServer.listen(config.server.port, () => {
    logger.info(`Smart Alert backend running`, {
      port: config.server.port,
      env: config.server.env,
      ws: `ws://localhost:${config.server.port}/ws`,
    });
  });

  httpServer.on('error', (err) => {
    logger.error('HTTP server error', { err: err.message });
    process.exit(1);
  });

  // ─── Graceful Shutdown ────────────────────────────────────────────────────
  const shutdown = (signal) => {
    logger.info(`${signal} received — shutting down gracefully`);
    httpServer.close(() => {
      closeDb();
      logger.info('Server closed');
      process.exit(0);
    });
    setTimeout(() => { logger.warn('Forced exit'); process.exit(1); }, 10000);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('uncaughtException', (err) => {
    logger.error('Uncaught exception', { err: err.message, stack: err.stack });
    process.exit(1);
  });
  process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled rejection', { reason });
  });

  return httpServer;
}

// Allow importing in tests without auto-starting
if (require.main === module) start();

module.exports = { app, start };
