const request = require('supertest');
const path = require('path');
const fs = require('fs');

process.env.DB_PATH = path.join(__dirname, '../data/test_smart_alert.db');
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret';

const { app, start } = require('../src/server');
const { closeDb } = require('../src/models/database');

let server;
let authToken;
let sessionId;

const TEST_USER = { username: 'testusr', password: 'testpass123' };

beforeAll(async () => {
  server = await start();
  await new Promise((resolve) => {
    if (server.listening) return resolve();
    server.on('listening', resolve);
  });
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  closeDb();
  const dbPath = path.resolve(process.env.DB_PATH);
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
});

describe('POST /api/auth/register', () => {
  it('creates a new user', async () => {
    const res = await request(app).post('/api/auth/register').send(TEST_USER);
    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty('token');
    expect(res.body.user.username).toBe(TEST_USER.username);
    authToken = res.body.token;
  });

  it('rejects duplicate username', async () => {
    const res = await request(app).post('/api/auth/register').send(TEST_USER);
    expect(res.status).toBe(409);
  });

  it('rejects short password', async () => {
    const res = await request(app).post('/api/auth/register').send({ username: 'other123', password: 'short' });
    expect(res.status).toBe(400);
  });
});

describe('POST /api/auth/login', () => {
  it('logs in with correct credentials', async () => {
    const res = await request(app).post('/api/auth/login').send(TEST_USER);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('token');
  });

  it('rejects wrong password', async () => {
    const res = await request(app).post('/api/auth/login').send({ username: TEST_USER.username, password: 'wrongpassword' });
    expect(res.status).toBe(401);
  });
});

describe('GET /api/auth/me', () => {
  it('returns current user', async () => {
    const res = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${authToken}`);
    expect(res.status).toBe(200);
    expect(res.body.user.username).toBe(TEST_USER.username);
  });

  it('rejects without token', async () => {
    const res = await request(app).get('/api/auth/me');
    expect(res.status).toBe(401);
  });
});

describe('POST /api/sessions', () => {
  it('creates a session', async () => {
    const res = await request(app)
      .post('/api/sessions')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ name: 'Test Session', sensitivity: 8, keywords: ['Alice', { word: 'hey', matchMode: 'exact' }] });
    expect(res.status).toBe(201);
    expect(res.body.session).toHaveProperty('id');
    expect(res.body.session.keywords.length).toBe(2);
    sessionId = res.body.session.id;
  });

  it('uses defaults when options omitted', async () => {
    const res = await request(app).post('/api/sessions').set('Authorization', `Bearer ${authToken}`).send({});
    expect(res.status).toBe(201);
    expect(res.body.session.sensitivity).toBe(7);
  });
});

describe('GET /api/sessions', () => {
  it('lists user sessions', async () => {
    const res = await request(app).get('/api/sessions').set('Authorization', `Bearer ${authToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.sessions)).toBe(true);
    expect(res.body.sessions.length).toBeGreaterThanOrEqual(1);
  });
});

describe('GET /api/sessions/:id', () => {
  it('returns session by id', async () => {
    const res = await request(app).get(`/api/sessions/${sessionId}`).set('Authorization', `Bearer ${authToken}`);
    expect(res.status).toBe(200);
    expect(res.body.session.id).toBe(sessionId);
  });

  it('returns 404 for unknown session', async () => {
    const res = await request(app).get('/api/sessions/nonexistent-id').set('Authorization', `Bearer ${authToken}`);
    expect(res.status).toBe(404);
  });
});

describe('Keywords', () => {
  let kwId;

  it('adds a keyword', async () => {
    const res = await request(app)
      .post(`/api/sessions/${sessionId}/keywords`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ word: 'Bob', matchMode: 'contains' });
    expect(res.status).toBe(201);
    expect(res.body.keyword.word).toBe('Bob');
    kwId = res.body.keyword.id;
  });

  it('removes a keyword', async () => {
    const res = await request(app)
      .delete(`/api/sessions/${sessionId}/keywords/${kwId}`)
      .set('Authorization', `Bearer ${authToken}`);
    expect(res.status).toBe(200);
    expect(res.body.removed).toBe(true);
  });
});

describe('Transcripts & Alerts', () => {
  it('analyzes transcript with no keyword match', async () => {
    const res = await request(app)
      .post(`/api/sessions/${sessionId}/transcript`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ transcript: 'The weather is nice today', isFinal: true });
    expect(res.status).toBe(200);
    expect(res.body.detectionsCount).toBe(0);
  });

  it('detects keyword in transcript', async () => {
    const res = await request(app)
      .post(`/api/sessions/${sessionId}/transcript`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ transcript: 'Alice can you join the call?', isFinal: true });
    expect(res.status).toBe(200);
    expect(res.body.detectionsCount).toBeGreaterThan(0);
  });

  it('skips analysis for interim results', async () => {
    const res = await request(app)
      .post(`/api/sessions/${sessionId}/transcript`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ transcript: 'Alice called you', isFinal: false });
    expect(res.status).toBe(200);
    expect(res.body.analyzed).toBe(false);
  });

  it('returns alert list', async () => {
    const res = await request(app).get(`/api/sessions/${sessionId}/alerts`).set('Authorization', `Bearer ${authToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.alerts)).toBe(true);
  });
});

describe('GET /health', () => {
  it('returns ok', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });
});
