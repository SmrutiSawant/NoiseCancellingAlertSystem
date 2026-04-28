# Noise-Canceling Smart Alert System — Backend

A Node.js/Express backend that processes real-time audio streams, suppresses background noise,
and fires alerts when a registered keyword (name, phrase) is detected in speech.

---

## Architecture

```
Browser (client)
  │
  ├── HTTP REST  →  Express API  →  SQLite (sessions, keywords, alerts, stats)
  │
  └── WebSocket  →  WS Server
                      │
                      ├── AudioProcessor   (PCM → FFT → noise suppression → VAD)
                      └── KeywordDetector  (transcript → fuzzy keyword match → alert)
```

### Audio Processing Pipeline

```
Raw PCM (Int16 LE)
  → Pre-emphasis filter       (boost highs, flatten spectrum)
  → Framing (512 samples)     (overlap-add with 50% hop)
  → Hamming window            (reduce spectral leakage)
  → Radix-2 FFT               (custom implementation, no deps)
  → Magnitude spectrum
  → Min-statistics noise est. (rolling minimum over ~1 s of frames)
  → Spectral subtraction      (α·noise floor removed per bin)
  → VAD (energy + ZCR)        (speech/silence classification)
  → Emit events               ('frame', 'speech', 'silence', 'stats')
```

### Keyword Detection

- **Exact** — full word boundary (`\bword\b`)
- **Contains** — substring (default) + Levenshtein fuzzy fallback (distance ≤ 1 for words ≥ 4 chars)
- **Prefix** — word starts with keyword
- Per-session cooldown + per-minute rate limiting prevent alert floods

---

## Quick Start

```bash
# 1. Install
npm install

# 2. Configure
cp .env.example .env
# Edit .env — at minimum set JWT_SECRET

# 3. Run
npm run dev          # development (nodemon)
npm start            # production

# 4. Test
npm test
```

Server starts on **http://localhost:3001**.  
WebSocket endpoint: **ws://localhost:3001/ws**

---

## REST API

All `/api/sessions` routes require `Authorization: Bearer <token>`.

### Auth

| Method | Path | Body | Description |
|--------|------|------|-------------|
| POST | `/api/auth/register` | `{ username, password, displayName? }` | Create account |
| POST | `/api/auth/login` | `{ username, password }` | Get JWT |
| GET | `/api/auth/me` | — | Current user |

### Sessions

| Method | Path | Body / Query | Description |
|--------|------|-------------|-------------|
| GET | `/api/sessions` | — | List your sessions |
| POST | `/api/sessions` | `{ name?, sensitivity?, noiseReductionStrength?, vadMode?, keywords? }` | Start session |
| GET | `/api/sessions/:id` | — | Get session + keywords |
| DELETE | `/api/sessions/:id` | — | Stop session |

**Create session body:**
```json
{
  "name": "WFH Monday",
  "sensitivity": 7,
  "noiseReductionStrength": 0.75,
  "vadMode": 3,
  "keywords": [
    "Alice",
    { "word": "hey", "matchMode": "exact", "caseSensitive": false }
  ]
}
```

### Keywords

| Method | Path | Body | Description |
|--------|------|------|-------------|
| POST | `/api/sessions/:id/keywords` | `{ word, matchMode?, caseSensitive? }` | Add keyword |
| DELETE | `/api/sessions/:id/keywords/:kwId` | — | Remove keyword |

### Transcript Submission

| Method | Path | Body | Description |
|--------|------|------|-------------|
| POST | `/api/sessions/:id/transcript` | See below | Submit STT result for analysis |

```json
{
  "transcript": "Hey Alice can you check this?",
  "confidence": 0.95,
  "noiseLevel": 42.3,
  "signalLevel": 71.0,
  "audioDurationMs": 2400,
  "isFinal": true
}
```

Response:
```json
{
  "analyzed": true,
  "detectionsCount": 1,
  "detections": [{ "matchedWord": "Alice", "confidence": 1.0 }]
}
```

### Alerts

| Method | Path | Query | Description |
|--------|------|-------|-------------|
| GET | `/api/sessions/:id/alerts` | `limit`, `offset`, `since` | Paginated alert log |
| PATCH | `/api/sessions/:id/alerts/:alertId/acknowledge` | — | Mark alert read |

---

## WebSocket Protocol

Connect to `ws://localhost:3001/ws`, then immediately authenticate.

### Client → Server messages

```jsonc
// 1. Authenticate (must be first message)
{ "type": "auth", "token": "<jwt>", "sessionId": "<session-id>" }

// 2. Send raw PCM audio (base64-encoded Int16 LE)
{ "type": "audio_chunk", "data": "<base64>" }

// 3. Send STT transcript
{
  "type": "transcript",
  "transcript": "Alice are you there?",
  "confidence": 0.92,
  "noiseLevel": 38.1,
  "signalLevel": 65.0,
  "isFinal": true
}

// 4. Heartbeat
{ "type": "ping" }
```

You can also send raw binary WebSocket frames (Int16 LE PCM) — no JSON wrapping needed.

### Server → Client messages

```jsonc
{ "type": "auth_ok",       "sessionId": "...", "userId": "..." }
{ "type": "auth_error",    "message": "..." }

// Per-frame audio stats (~60 fps)
{ "type": "frame_stats",   "noiseDb": -42.1, "signalDb": -18.3, "isSpeech": true, "energy": 0.12 }

// Every ~1 second
{ "type": "session_stats", "speechFrames": 120, "silenceFrames": 300, "speechRatio": 0.286, ... }

// On keyword detection
{
  "type": "alert",
  "alertId": "uuid",
  "sessionId": "uuid",
  "matchedWord": "Alice",
  "transcript": "Alice are you there?",
  "confidence": 1.0,
  "triggeredAt": 1712000000000
}

{ "type": "pong" }
{ "type": "error", "message": "..." }
```

---

## Configuration (`.env`)

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3001` | HTTP + WS port |
| `JWT_SECRET` | *(required)* | Sign/verify tokens |
| `JWT_EXPIRES_IN` | `7d` | Token lifetime |
| `DB_PATH` | `./data/smart_alert.db` | SQLite file path |
| `AUDIO_SAMPLE_RATE` | `16000` | Expected PCM sample rate (Hz) |
| `VAD_MODE` | `3` | 0=permissive … 3=aggressive |
| `NOISE_REDUCTION_STRENGTH` | `0.75` | Spectral subtraction α (0–1) |
| `ALERT_COOLDOWN_MS` | `2000` | Min ms between alerts per session |
| `MAX_ALERTS_PER_MINUTE` | `10` | Hard rate cap |
| `LOG_LEVEL` | `info` | winston level |

---

## Database Schema

```
users          — accounts (id, username, password_hash, display_name)
sessions       — listening sessions (sensitivity, vad_mode, noise_reduction_strength)
keywords       — per-session keywords (word, match_mode, case_sensitive)
alerts         — detected name events (transcript, confidence, noise/signal levels)
noise_stats    — periodic audio telemetry snapshots
```

---

## Frontend Integration (quick-start)

```javascript
// 1. Register / login
const { token } = await fetch('/api/auth/login', {
  method: 'POST',
  body: JSON.stringify({ username: 'you', password: 'pass' }),
  headers: { 'Content-Type': 'application/json' },
}).then(r => r.json());

// 2. Create session
const { session } = await fetch('/api/sessions', {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ keywords: ['Alice', 'hey'], sensitivity: 8 }),
}).then(r => r.json());

// 3. Open WebSocket
const ws = new WebSocket('ws://localhost:3001/ws');
ws.onopen = () => ws.send(JSON.stringify({ type: 'auth', token, sessionId: session.id }));

// 4. Stream transcripts from Web Speech API
const recognition = new webkitSpeechRecognition();
recognition.continuous = true;
recognition.onresult = (e) => {
  const transcript = e.results[e.results.length - 1][0].transcript;
  const isFinal = e.results[e.results.length - 1].isFinal;
  ws.send(JSON.stringify({ type: 'transcript', transcript, isFinal }));
};

// 5. Handle alerts
ws.onmessage = (e) => {
  const msg = JSON.parse(e.data);
  if (msg.type === 'alert') {
    console.log(`🔔 "${msg.matchedWord}" detected!`, msg.transcript);
  }
};
```
