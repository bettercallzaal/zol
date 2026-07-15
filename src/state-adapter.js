// state-adapter.js - Durable state adapter for DreamLoops integration
// Implements the vendored state-store interface with two backends:
// - SQLite-WAL (primary, optional, uses better-sqlite3)
// - Atomic-file (fallback, always available)
//
// Backend selection: ZOL_STATE_BACKEND=sqlite (if better-sqlite3 loads) or atomic-file
// Default (no env): existing ZOL behavior unchanged (adapter not wired into live daemons)

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Secret patterns that should never be persisted
const SECRET_PATTERNS = [
  /[0-9a-fA-F]{64}/, // 64-char hex (private keys)
  /sk-[a-zA-Z0-9_-]+/, // OpenAI/OpenRouter keys
  /ghp_[a-zA-Z0-9_-]+/, // GitHub personal access tokens
  /PRIVATE\s*KEY/i, // PEM private key blocks
];

function shouldRejectValue(value) {
  const str = JSON.stringify(value);
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.test(str)) return true;
  }
  return false;
}

// Atomic-file backend: write-to-temp-then-rename
class AtomicFileStore {
  constructor({ directory, maxBytes = 1_048_576 } = {}) {
    if (!directory) throw new Error('AtomicFileStore requires a directory');
    this.directory = path.resolve(directory);
    this.maxBytes = maxBytes;
    this.name = 'atomic-file';
  }

  async initialize() {
    await fs.promises.mkdir(path.join(this.directory, 'state'), { recursive: true });
    await fs.promises.mkdir(path.join(this.directory, 'receipts'), { recursive: true });
  }

  statePath(key) {
    return path.join(this.directory, 'state', `${this._safeName(key)}.json`);
  }

  _safeName(key) {
    return crypto.createHash('sha256').update(key).digest('hex');
  }

  async get(key) {
    await this.initialize();
    try {
      const envelope = JSON.parse(await fs.promises.readFile(this.statePath(key), 'utf8'));
      if (envelope.key !== key) throw new Error('state key integrity check failed');
      return JSON.parse(JSON.stringify(envelope.value)); // clone
    } catch (error) {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    }
  }

  async put(key, value) {
    // Guard: reject secret patterns
    if (shouldRejectValue(JSON.stringify(value))) {
      throw new Error(`[SECURITY] Refusing to persist value with secret pattern for key: ${key}`);
    }

    await this.initialize();
    const envelope = { key, updatedAt: new Date().toISOString(), value: JSON.parse(JSON.stringify(value)) };
    const envelopeBytes = Buffer.byteLength(JSON.stringify(envelope), 'utf8');
    if (envelopeBytes > this.maxBytes) throw new Error(`state exceeds ${this.maxBytes} byte ceiling`);

    const target = this.statePath(key);
    const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
    await fs.promises.writeFile(temporary, `${JSON.stringify(envelope, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await fs.promises.rename(temporary, target);
  }

  async delete(key) {
    await this.initialize();
    try {
      await fs.promises.unlink(this.statePath(key));
      return true;
    } catch (error) {
      if (error.code === 'ENOENT') return false;
      throw error;
    }
  }

  async list() {
    await this.initialize();
    const stateDir = path.join(this.directory, 'state');
    const names = (await fs.promises.readdir(stateDir)).filter((name) => name.endsWith('.json'));
    const keys = [];
    for (const name of names) {
      try {
        const envelope = JSON.parse(await fs.promises.readFile(path.join(stateDir, name), 'utf8'));
        keys.push(envelope.key);
      } catch (e) {
        // skip malformed files
      }
    }
    return keys.sort();
  }

  async appendReceipt(receipt) {
    await this.initialize();
    const redacted = { ...JSON.parse(JSON.stringify(receipt)) };
    delete redacted.state;
    const date = new Date().toISOString().slice(0, 10);
    const receiptPath = path.join(this.directory, 'receipts', `${date}.jsonl`);
    await fs.promises.appendFile(receiptPath, `${JSON.stringify(redacted)}\n`, { encoding: 'utf8', mode: 0o600 });
  }
}

// SQLite-WAL backend (optional)
class SqliteWalStore {
  constructor({ directory, maxBytes = 1_048_576 } = {}) {
    if (!directory) throw new Error('SqliteWalStore requires a directory');
    this.directory = path.resolve(directory);
    this.maxBytes = maxBytes;
    this.name = 'sqlite-wal';
    this.db = null;
    this.available = false;

    // Try to load better-sqlite3
    try {
      const Database = require('better-sqlite3');
      this.Database = Database;
      this.available = true;
    } catch (e) {
      this.available = false;
      this.initError = e;
    }
  }

  async initialize() {
    if (!this.available) {
      throw new Error(`SQLite backend unavailable: ${this.initError?.message || 'better-sqlite3 not installed'}`);
    }

    if (this.db) return; // already initialized

    await fs.promises.mkdir(this.directory, { recursive: true });
    await fs.promises.mkdir(path.join(this.directory, 'receipts'), { recursive: true });

    const dbPath = path.join(this.directory, 'zol-state.db');
    this.db = new this.Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');

    // Create tables
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS state_kv (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS receipts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        date TEXT NOT NULL,
        receipt TEXT NOT NULL,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_receipts_date ON receipts(date);
    `);
  }

  async get(key) {
    await this.initialize();
    const stmt = this.db.prepare('SELECT value FROM state_kv WHERE key = ?');
    const row = stmt.get(key);
    if (!row) return undefined;
    return JSON.parse(row.value);
  }

  async put(key, value) {
    // Guard: reject secret patterns
    if (shouldRejectValue(JSON.stringify(value))) {
      throw new Error(`[SECURITY] Refusing to persist value with secret pattern for key: ${key}`);
    }

    await this.initialize();
    const jsonValue = JSON.stringify(value);
    const bytes = Buffer.byteLength(jsonValue, 'utf8');
    if (bytes > this.maxBytes) throw new Error(`state exceeds ${this.maxBytes} byte ceiling`);

    const stmt = this.db.prepare(`
      INSERT INTO state_kv (key, value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_at = excluded.updated_at
    `);
    stmt.run(key, jsonValue, new Date().toISOString());
  }

  async delete(key) {
    await this.initialize();
    const stmt = this.db.prepare('DELETE FROM state_kv WHERE key = ?');
    const result = stmt.run(key);
    return result.changes > 0;
  }

  async list() {
    await this.initialize();
    const stmt = this.db.prepare('SELECT key FROM state_kv ORDER BY key');
    const rows = stmt.all();
    return rows.map((r) => r.key);
  }

  async appendReceipt(receipt) {
    await this.initialize();
    const redacted = { ...JSON.parse(JSON.stringify(receipt)) };
    delete redacted.state;
    const date = new Date().toISOString().slice(0, 10);
    const stmt = this.db.prepare('INSERT INTO receipts (date, receipt) VALUES (?, ?)');
    stmt.run(date, JSON.stringify(redacted));
  }

  close() {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }
}

// Factory: select backend based on env and availability
async function createStateStore(directory = null) {
  const dir = directory || path.join(process.env.HOME || '/root', 'zol', 'state');
  const backendEnv = process.env.ZOL_STATE_BACKEND || 'atomic-file';

  let store;
  if (backendEnv === 'sqlite') {
    store = new SqliteWalStore({ directory: dir });
    try {
      await store.initialize();
      console.log(`[StateAdapter] Using SQLite-WAL backend at ${path.join(dir, 'zol-state.db')}`);
      return store;
    } catch (e) {
      console.warn(`[StateAdapter] SQLite initialization failed: ${e.message}. Falling back to atomic-file.`);
    }
  }

  // Fallback to atomic-file
  store = new AtomicFileStore({ directory: dir });
  await store.initialize();
  console.log(`[StateAdapter] Using atomic-file backend at ${dir}/state/`);
  return store;
}

module.exports = { createStateStore, AtomicFileStore, SqliteWalStore, shouldRejectValue };
