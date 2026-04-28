const { WebSocketServer, OPEN } = require('ws');
const { parse: parseUrl } = require('url');
const { verifyWsToken } = require('../middleware/auth');
const sessionManager = require('./sessionManager');
const logger = require('../utils/logger');

const MSG_TYPE = {
  AUTH: 'auth',
  AUTH_OK: 'auth_ok',
  AUTH_ERR: 'auth_error',
  AUDIO_CHUNK: 'audio_chunk',
  TRANSCRIPT: 'transcript',
  FRAME_STATS: 'frame_stats',
  ALERT: 'alert',
  SESSION_STATS: 'session_stats',
  PING: 'ping',
  PONG: 'pong',
  ERROR: 'error',
};

/**
 * WebSocketServer
 *
 * Protocol (all messages are JSON unless noted):
 *
 * Client → Server:
 *   { type: 'auth',        token: '<jwt>', sessionId: '<id>' }
 *   { type: 'audio_chunk', data: '<base64 Int16 PCM>' }       ← binary or base64
 *   { type: 'transcript',  transcript: '...', confidence: 0.9, isFinal: true }
 *   { type: 'ping' }
 *
 * Server → Client:
 *   { type: 'auth_ok',      sessionId, userId }
 *   { type: 'auth_error',   message }
 *   { type: 'frame_stats',  noiseDb, signalDb, isSpeech }
 *   { type: 'alert',        alertId, matchedWord, transcript, triggeredAt }
 *   { type: 'session_stats', ...AudioProcessor.getStats() }
 *   { type: 'pong' }
 *   { type: 'error',        message }
 */
function createWsServer(httpServer) {
  const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

  wss.on('connection', (ws, req) => {
    const ip = req.socket.remoteAddress;
    logger.debug('WS connection opened', { ip });

    ws._authenticated = false;
    ws._user = null;
    ws._sessionId = null;

    // Heartbeat
    ws._alive = true;
    ws.on('pong', () => { ws._alive = true; });

    ws.on('message', (rawData, isBinary) => {
      try {
        if (isBinary) {
          handleBinaryAudio(ws, rawData);
          return;
        }

        const msg = JSON.parse(rawData.toString());
        handleMessage(ws, msg);
      } catch (err) {
        logger.warn('WS message parse error', { err: err.message });
        safeSend(ws, { type: MSG_TYPE.ERROR, message: 'Invalid message format' });
      }
    });

    ws.on('close', (code, reason) => {
      logger.debug('WS connection closed', { code, reason: reason.toString(), sessionId: ws._sessionId });
      if (ws._sessionId) {
        sessionManager.unregisterWsClient(ws._sessionId, ws);
      }
    });

    ws.on('error', (err) => {
      logger.error('WS error', { err: err.message, sessionId: ws._sessionId });
    });

    // Auth timeout: close if not authenticated within 5 s
    const authTimeout = setTimeout(() => {
      if (!ws._authenticated) {
        ws.close(4001, 'Authentication timeout');
      }
    }, 5000);
    ws.once('message', () => clearTimeout(authTimeout));
  });

  // Heartbeat interval — drop dead connections every 30 s
  const heartbeatInterval = setInterval(() => {
    wss.clients.forEach((ws) => {
      if (!ws._alive) { ws.terminate(); return; }
      ws._alive = false;
      ws.ping();
    });
  }, 30000);

  wss.on('close', () => clearInterval(heartbeatInterval));

  logger.info('WebSocket server ready on /ws');
  return wss;
}

// ─── Message Handlers ─────────────────────────────────────────────────────────

function handleMessage(ws, msg) {
  switch (msg.type) {
    case MSG_TYPE.PING:
      safeSend(ws, { type: MSG_TYPE.PONG });
      break;

    case MSG_TYPE.AUTH:
      handleAuth(ws, msg);
      break;

    case MSG_TYPE.TRANSCRIPT:
      if (!assertAuth(ws)) return;
      handleTranscript(ws, msg);
      break;

    case MSG_TYPE.AUDIO_CHUNK:
      if (!assertAuth(ws)) return;
      if (msg.data) {
        const buf = Buffer.from(msg.data, 'base64');
        handleBinaryAudio(ws, buf);
      }
      break;

    default:
      safeSend(ws, { type: MSG_TYPE.ERROR, message: `Unknown message type: ${msg.type}` });
  }
}

function handleAuth(ws, msg) {
  const user = verifyWsToken(msg.token);
  if (!user) {
    safeSend(ws, { type: MSG_TYPE.AUTH_ERR, message: 'Invalid or expired token' });
    ws.close(4001, 'Unauthorized');
    return;
  }

  const session = sessionManager.getSession(msg.sessionId);
  if (!session) {
    safeSend(ws, { type: MSG_TYPE.AUTH_ERR, message: 'Session not found' });
    return;
  }
  if (session.user_id !== user.id) {
    safeSend(ws, { type: MSG_TYPE.AUTH_ERR, message: 'Forbidden' });
    return;
  }

  ws._authenticated = true;
  ws._user = user;
  ws._sessionId = msg.sessionId;

  sessionManager.registerWsClient(msg.sessionId, ws);

  // Pipe AudioProcessor frame events to this client
  const active = sessionManager._active.get(msg.sessionId);
  if (active) {
    active.processor.on('frame', (frameData) => {
      if (ws.readyState === OPEN) {
        safeSend(ws, { type: MSG_TYPE.FRAME_STATS, ...frameData });
      }
    });
    active.processor.on('stats', (stats) => {
      if (ws.readyState === OPEN) {
        safeSend(ws, { type: MSG_TYPE.SESSION_STATS, ...stats });
      }
    });
  }

  logger.info('WS client authenticated', { userId: user.id, sessionId: msg.sessionId });
  safeSend(ws, { type: MSG_TYPE.AUTH_OK, sessionId: msg.sessionId, userId: user.id });
}

function handleBinaryAudio(ws, buf) {
  if (!ws._authenticated || !ws._sessionId) return;
  try {
    sessionManager.processAudio(ws._sessionId, buf);
  } catch (err) {
    logger.warn('WS audio processing error', { err: err.message });
    safeSend(ws, { type: MSG_TYPE.ERROR, message: err.message });
  }
}

function handleTranscript(ws, msg) {
  const { transcript, confidence, noiseLevel, signalLevel, audioDurationMs, isFinal } = msg;
  if (!transcript) return;

  try {
    sessionManager.analyzeTranscript(ws._sessionId, transcript, {
      confidence, noiseLevel, signalLevel, audioDurationMs,
    });
  } catch (err) {
    logger.warn('WS transcript analysis error', { err: err.message });
    safeSend(ws, { type: MSG_TYPE.ERROR, message: err.message });
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function safeSend(ws, data) {
  if (ws.readyState === OPEN) {
    ws.send(JSON.stringify(data));
  }
}

function assertAuth(ws) {
  if (!ws._authenticated) {
    safeSend(ws, { type: MSG_TYPE.ERROR, message: 'Not authenticated' });
    return false;
  }
  return true;
}

module.exports = { createWsServer, MSG_TYPE };
