const initSqlJs = require('sql.js');
const path = require('path');
const fs = require('fs');
const config = require('../../config');
const logger = require('../utils/logger');

let _db = null;   // sql.js Database instance
let _wrapper = null;
let dbPath = null;

// ─── Flush to disk ────────────────────────────────────────────────────────────

function saveDb() {
  if (!_db || !dbPath) return;
  const data = _db.export();
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(dbPath, Buffer.from(data));
}

// ─── Statement ────────────────────────────────────────────────────────────────

class Statement {
  constructor(sql) {
    this._sql = sql;
  }

  run(...args) {
    const params = args.flat();
    try {
      _db.run(this._sql, params);
      const changes = _db.getRowsModified();
      saveDb();
      return { changes, lastInsertRowid: null };
    } catch (e) {
      if (!e.message.includes('UNIQUE constraint failed')) throw e;
      return { changes: 0, lastInsertRowid: null };
    }
  }

  get(...args) {
    const params = args.flat();
    const stmt = _db.prepare(this._sql);
    stmt.bind(params);
    let row;
    if (stmt.step()) row = stmt.getAsObject();
    stmt.free();
    return row;
  }

  all(...args) {
    const params = args.flat();
    const stmt = _db.prepare(this._sql);
    const rows = [];
    stmt.bind(params);
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free();
    return rows;
  }
}

// ─── DB wrapper ───────────────────────────────────────────────────────────────

class DbWrapper {
  prepare(sql) { return new Statement(sql); }

  exec(sql) { _db.exec(sql); saveDb(); }

  run(sql, params = []) {
    _db.run(sql, params);
    saveDb();
    return { changes: _db.getRowsModified() };
  }

  pragma() { /* no-op */ }

  transaction(fn) {
    return (...args) => {
      _db.run('BEGIN');
      try {
        const result = fn(...args);
        _db.run('COMMIT');
        saveDb();
        return result;
      } catch (err) {
        try { _db.run('ROLLBACK'); } catch (_) {}
        throw err;
      }
    };
  }

  close() { saveDb(); _db.close(); }
}

// ─── Public API ───────────────────────────────────────────────────────────────

async function initDb() {
  const SQL = await initSqlJs();
  dbPath = path.resolve(config.db.path);

  const dbDir = path.dirname(dbPath);
  if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

  if (fs.existsSync(dbPath)) {
    _db = new SQL.Database(fs.readFileSync(dbPath));
    logger.info('Database loaded from disk', { path: dbPath });
  } else {
    _db = new SQL.Database();
    logger.info('New database created', { path: dbPath });
  }

  _wrapper = new DbWrapper();
  runMigrations();
  return _wrapper;
}

function getDb() {
  if (!_wrapper) throw new Error('Database not initialized. Call initDb() first.');
  return _wrapper;
}

function runMigrations() {
  _db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      display_name TEXT,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL DEFAULT 'My Session',
      sensitivity INTEGER NOT NULL DEFAULT 7,
      noise_reduction_strength REAL NOT NULL DEFAULT 0.75,
      vad_mode INTEGER NOT NULL DEFAULT 3,
      is_active INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );
    CREATE TABLE IF NOT EXISTS keywords (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      word TEXT NOT NULL,
      match_mode TEXT NOT NULL DEFAULT 'contains',
      case_sensitive INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      UNIQUE(session_id, word)
    );
    CREATE TABLE IF NOT EXISTS alerts (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      keyword_id TEXT,
      matched_word TEXT NOT NULL,
      transcript TEXT,
      confidence REAL,
      noise_level REAL,
      signal_level REAL,
      audio_duration_ms INTEGER,
      triggered_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      acknowledged_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS noise_stats (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      recorded_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      avg_noise_db REAL,
      peak_noise_db REAL,
      avg_signal_db REAL,
      vad_speech_frames INTEGER DEFAULT 0,
      vad_noise_frames INTEGER DEFAULT 0,
      alerts_triggered INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_alerts_session ON alerts(session_id);
    CREATE INDEX IF NOT EXISTS idx_alerts_triggered ON alerts(triggered_at);
    CREATE INDEX IF NOT EXISTS idx_keywords_session ON keywords(session_id);
    CREATE INDEX IF NOT EXISTS idx_noise_stats_session ON noise_stats(session_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
  `);
  saveDb();
  logger.info('Database migrations complete');
}

function closeDb() {
  if (_wrapper) {
    _wrapper.close();
    _wrapper = null;
    _db = null;
    logger.info('Database connection closed');
  }
}

module.exports = { initDb, getDb, closeDb };
