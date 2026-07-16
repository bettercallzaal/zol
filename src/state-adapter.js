// state-adapter.js - Durable state adapter for DreamLoops integration
// Implements the vendored state-store interface with three backends:
// - SQLite-WAL (optional, uses better-sqlite3)
// - Atomic-file (fallback, always available)
// - Bonfire (optional, uses shared-graph knowledge-graph backend)
//
// Backend selection: ZOL_STATE_BACKEND=sqlite|atomic-file|bonfire
// Default (no env): atomic-file
// Default (production): existing ZOL behavior unchanged (adapter not wired into live daemons)

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

// Bonfire backend: shared-graph knowledge-graph storage
// Episodes are stored with the key in the episode name; queries retrieve by key.
// Secret patterns are checked before write. Missing creds => error on initialize.
class BonfireStore {
  constructor({ apiKey, bonfireId, apiUrl, maxBytes = 1_048_576 } = {}) {
    this.apiKey = apiKey || process.env.BONFIRE_API_KEY || '';
    this.bonfireId = bonfireId || process.env.BONFIRE_ID || '';
    this.apiUrl = apiUrl || process.env.BONFIRE_API_URL || 'https://tnt-v2.api.bonfires.ai';
    this.maxBytes = maxBytes;
    this.name = 'bonfire';
    this.initialized = false;
    // Use the same patterns as the other stores to ensure consistency
    this.secretPatterns = SECRET_PATTERNS;
  }

  async initialize() {
    if (this.initialized) return;
    if (!this.apiKey || !this.bonfireId) {
      throw new Error(
        'BonfireStore requires BONFIRE_API_KEY and BONFIRE_ID environment variables (or constructor opts)'
      );
    }
    this.initialized = true;
  }

  _containsSecret(text) {
    const str = typeof text === 'string' ? text : JSON.stringify(text);
    return this.secretPatterns.some((re) => re.test(str));
  }

  _episodeName(key) {
    // Episodes are named after the key for later retrieval.
    // Use a hash to avoid special char issues in episode names.
    return `zol-state:${crypto.createHash('sha256').update(key).digest('hex')}`;
  }

  _keyFromEpisodeName(name) {
    // Extract the original key from the episode name (reverse lookup during delve).
    // This is stored as metadata in the episode body so we can map back.
    return name.replace(/^zol-state:/, '');
  }

  async get(key) {
    await this.initialize();
    try {
      // Query Bonfire /delve with the episode name.
      const episodeName = this._episodeName(key);
      const res = await fetch(`${this.apiUrl}/delve`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          bonfire_id: this.bonfireId,
          query: `episode name is "${episodeName}"`,
        }),
        signal: AbortSignal.timeout(10_000),
      });

      if (!res.ok) {
        throw new Error(`Bonfire /delve returned HTTP ${res.status}`);
      }

      const json = await res.json();
      const episodes = json.episodes || [];

      // Find the episode matching this key
      for (const episode of episodes) {
        if (episode.name === episodeName) {
          try {
            // The value is stored in the episode body as JSON
            const envelope = JSON.parse(episode.content || episode.summary || '{}');
            if (envelope.key === key) {
              return JSON.parse(JSON.stringify(envelope.value));
            }
          } catch (e) {
            // Skip malformed episodes
          }
        }
      }

      // Not found
      return undefined;
    } catch (error) {
      throw new Error(`[BonfireStore] get(${key}) failed: ${error.message}`);
    }
  }

  async put(key, value) {
    await this.initialize();

    // Guard: reject secret patterns
    if (this._containsSecret(JSON.stringify(value))) {
      throw new Error(`[SECURITY] Refusing to persist value with secret pattern for key: ${key}`);
    }

    const envelope = { key, updatedAt: new Date().toISOString(), value };
    const envelopeJson = JSON.stringify(envelope, null, 2);
    const bytes = Buffer.byteLength(envelopeJson, 'utf8');

    if (bytes > this.maxBytes) {
      throw new Error(`state exceeds ${this.maxBytes} byte ceiling`);
    }

    try {
      const episodeName = this._episodeName(key);
      const res = await fetch(`${this.apiUrl}/knowledge_graph/episode/create`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          bonfire_id: this.bonfireId,
          name: episodeName,
          episode_body: envelopeJson,
          source: 'text',
          source_description: 'zol:dreamloops-state',
          reference_time: new Date().toISOString(),
        }),
        signal: AbortSignal.timeout(15_000),
      });

      if (!res.ok) {
        const detail = (await res.text().catch(() => '')).slice(0, 200);
        throw new Error(`Bonfire /episode/create returned HTTP ${res.status}: ${detail}`);
      }

      const json = await res.json().catch(() => ({}));
      if (json.success === false) {
        throw new Error(`Bonfire episode create returned success: false`);
      }
    } catch (error) {
      throw new Error(`[BonfireStore] put(${key}) failed: ${error.message}`);
    }
  }

  async delete(key) {
    await this.initialize();
    // Bonfire does not support episode deletion via API.
    // Log and return false to indicate the deletion did not occur.
    console.warn(`[BonfireStore] delete(${key}) not supported by Bonfire API - episode remains in graph`);
    return false;
  }

  async list() {
    await this.initialize();
    try {
      // Query for all ZOL state episodes.
      const res = await fetch(`${this.apiUrl}/delve`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          bonfire_id: this.bonfireId,
          query: 'zol-state episodes',
        }),
        signal: AbortSignal.timeout(10_000),
      });

      if (!res.ok) {
        throw new Error(`Bonfire /delve returned HTTP ${res.status}`);
      }

      const json = await res.json();
      const episodes = json.episodes || [];
      const keys = [];

      // Extract keys from valid episodes.
      for (const episode of episodes) {
        if (episode.name && episode.name.startsWith('zol-state:')) {
          try {
            const envelope = JSON.parse(episode.content || episode.summary || '{}');
            if (envelope.key) {
              keys.push(envelope.key);
            }
          } catch (e) {
            // Skip malformed episodes
          }
        }
      }

      return keys.sort();
    } catch (error) {
      throw new Error(`[BonfireStore] list() failed: ${error.message}`);
    }
  }

  async appendReceipt(receipt) {
    await this.initialize();
    try {
      const redacted = { ...JSON.parse(JSON.stringify(receipt)) };
      delete redacted.state;
      const date = new Date().toISOString().slice(0, 10);
      const episodeName = `zol-receipt:${date}:${crypto.randomUUID()}`;

      await fetch(`${this.apiUrl}/knowledge_graph/episode/create`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          bonfire_id: this.bonfireId,
          name: episodeName,
          episode_body: JSON.stringify(redacted, null, 2),
          source: 'text',
          source_description: 'zol:dreamloops-receipt',
          reference_time: new Date().toISOString(),
        }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      // Best-effort: log but don't throw (receipts are observability, not critical path)
      console.warn(`[BonfireStore] appendReceipt() failed: ${error.message}`);
    }
  }
}

// Factory: select backend based on env and availability
async function createStateStore(directory = null) {
  const dir = directory || path.join(process.env.HOME || '/root', 'zol', 'state');
  const backendEnv = process.env.ZOL_STATE_BACKEND || 'atomic-file';

  let store;

  if (backendEnv === 'bonfire') {
    store = new BonfireStore();
    try {
      await store.initialize();
      console.log(`[StateAdapter] Using Bonfire backend (${store.apiUrl})`);
      return store;
    } catch (e) {
      console.warn(`[StateAdapter] Bonfire initialization failed: ${e.message}. Falling back to atomic-file.`);
    }
  }

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

  // Fallback to atomic-file (always available)
  store = new AtomicFileStore({ directory: dir });
  await store.initialize();
  console.log(`[StateAdapter] Using atomic-file backend at ${dir}/state/`);
  return store;
}

module.exports = { createStateStore, AtomicFileStore, SqliteWalStore, BonfireStore, shouldRejectValue };
