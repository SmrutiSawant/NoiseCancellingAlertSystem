require('dotenv').config();

const config = {
  server: {
    port: parseInt(process.env.PORT) || 3001,
    wsPort: parseInt(process.env.WS_PORT) || 3002,
    env: process.env.NODE_ENV || 'development',
  },

  auth: {
    jwtSecret: process.env.JWT_SECRET || 'dev-secret-change-me',
    jwtExpiresIn: process.env.JWT_EXPIRES_IN || '7d',
  },

  db: {
    path: process.env.DB_PATH || './data/smart_alert.db',
  },

  audio: {
    sampleRate: parseInt(process.env.AUDIO_SAMPLE_RATE) || 16000,
    channels: parseInt(process.env.AUDIO_CHANNELS) || 1,
    bitDepth: parseInt(process.env.AUDIO_BIT_DEPTH) || 16,
    vadFrameLength: parseInt(process.env.VAD_FRAME_LENGTH) || 30,
    vadMode: parseInt(process.env.VAD_MODE) || 3,
  },

  noise: {
    floorDb: parseFloat(process.env.NOISE_FLOOR_DB) || -60,
    signalThresholdDb: parseFloat(process.env.SIGNAL_THRESHOLD_DB) || -30,
    reductionStrength: parseFloat(process.env.NOISE_REDUCTION_STRENGTH) || 0.75,
  },

  alerts: {
    cooldownMs: parseInt(process.env.ALERT_COOLDOWN_MS) || 500,
    maxPerMinute: parseInt(process.env.MAX_ALERTS_PER_MINUTE) || 10,
  },

  rateLimit: {
    windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 60000,
    maxRequests: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS) || 100,
  },

  logging: {
    level: process.env.LOG_LEVEL || 'info',
    file: process.env.LOG_FILE || './logs/app.log',
  },
};

module.exports = config;
