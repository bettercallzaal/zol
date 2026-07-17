// state-adapter.test.js - Tests for SQLite-WAL, atomic-file, and Bonfire state adapters
// Run: node --test src/__tests__/state-adapter.test.js

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { createStateStore, AtomicFileStore, SqliteWalStore, BonfireStore, shouldRejectValue, StateStoreInitError } = require('../state-adapter');

// Test both backends: sqlite (if available) and atomic-file
const BACKENDS_TO_TEST = ['atomic-file'];

// Try to add sqlite if available — probe native binding by opening :memory: DB.
// require() alone succeeds even when --ignore-scripts skipped the native build;
// the binding error only surfaces on first DB open, so we must probe here.
try {
  const Database = require('better-sqlite3');
  const _probe = new Database(':memory:');
  _probe.close();
  BACKENDS_TO_TEST.push('sqlite');
} catch (e) {
  console.warn('[Test] better-sqlite3 native binding not available, skipping SQLite tests');
}

function createTestDir(backendName, testName) {
  const unique = crypto.randomBytes(4).toString('hex');
  return path.join(os.tmpdir(), `zol-state-${backendName}-${testName}-${unique}`);
}

async function testBackend(backendName) {
  test(`${backendName}: create store and initialize`, async (t) => {
    const testDir = createTestDir(backendName, 'init');
    try {
      const store = backendName === 'sqlite' ? new SqliteWalStore({ directory: testDir }) : new AtomicFileStore({ directory: testDir });

      await store.initialize();
      if (backendName === 'atomic-file') {
        assert.ok(fs.existsSync(path.join(testDir, 'state')), 'state directory exists');
      }
      assert.ok(fs.existsSync(path.join(testDir, 'receipts')), 'receipts directory exists');

      if (store.close) store.close();
    } finally {
      if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  test(`${backendName}: put and get`, async (t) => {
    const testDir = createTestDir(backendName, 'putget');
    try {
      const store = backendName === 'sqlite' ? new SqliteWalStore({ directory: testDir }) : new AtomicFileStore({ directory: testDir });

      const testData = { foo: 'bar', num: 42, arr: [1, 2, 3] };
      await store.put('test-key', testData);

      const retrieved = await store.get('test-key');
      assert.deepStrictEqual(retrieved, testData);

      if (store.close) store.close();
    } finally {
      if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  test(`${backendName}: get non-existent key returns undefined`, async (t) => {
    const testDir = createTestDir(backendName, 'getnoent');
    try {
      const store = backendName === 'sqlite' ? new SqliteWalStore({ directory: testDir }) : new AtomicFileStore({ directory: testDir });

      const retrieved = await store.get('does-not-exist');
      assert.strictEqual(retrieved, undefined);

      if (store.close) store.close();
    } finally {
      if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  test(`${backendName}: list keys`, async (t) => {
    const testDir = createTestDir(backendName, 'list');
    try {
      const store = backendName === 'sqlite' ? new SqliteWalStore({ directory: testDir }) : new AtomicFileStore({ directory: testDir });

      await store.put('key1', { val: 1 });
      await store.put('key2', { val: 2 });
      await store.put('key3', { val: 3 });

      const keys = await store.list();
      assert.deepStrictEqual(keys.sort(), ['key1', 'key2', 'key3']);

      if (store.close) store.close();
    } finally {
      if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  test(`${backendName}: delete key`, async (t) => {
    const testDir = createTestDir(backendName, 'delete');
    try {
      const store = backendName === 'sqlite' ? new SqliteWalStore({ directory: testDir }) : new AtomicFileStore({ directory: testDir });

      await store.put('to-delete', { val: 'x' });
      const deleted = await store.delete('to-delete');
      assert.ok(deleted);

      const retrieved = await store.get('to-delete');
      assert.strictEqual(retrieved, undefined);

      if (store.close) store.close();
    } finally {
      if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  test(`${backendName}: delete non-existent key returns false`, async (t) => {
    const testDir = createTestDir(backendName, 'delnoent');
    try {
      const store = backendName === 'sqlite' ? new SqliteWalStore({ directory: testDir }) : new AtomicFileStore({ directory: testDir });

      const deleted = await store.delete('does-not-exist');
      assert.strictEqual(deleted, false);

      if (store.close) store.close();
    } finally {
      if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  test(`${backendName}: secret guard allows sha256 hashes (evidence, not secrets)`, async (t) => {
    const testDir = createTestDir(backendName, 'sha256hash');
    try {
      const store = backendName === 'sqlite' ? new SqliteWalStore({ directory: testDir }) : new AtomicFileStore({ directory: testDir });

      const hashValue = 'a'.repeat(64); // valid SHA-256 hex — evidence, not a secret
      await store.put('receipt-chain', { sha256: hashValue, content_hash: hashValue, commit_hash: hashValue });
      const retrieved = await store.get('receipt-chain');
      assert.strictEqual(retrieved.sha256, hashValue, 'SHA-256 evidence hash must survive round-trip');

      if (store.close) store.close();
    } finally {
      if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  test(`${backendName}: secret guard rejects hex in credential-named fields`, async (t) => {
    const testDir = createTestDir(backendName, 'credhex');
    try {
      const store = backendName === 'sqlite' ? new SqliteWalStore({ directory: testDir }) : new AtomicFileStore({ directory: testDir });

      const hexKey = 'a'.repeat(64);
      try {
        await store.put('keys', { private_key: hexKey });
        assert.fail('Should have rejected hex in private_key field');
      } catch (e) {
        assert.match(e.message, /SECURITY.*secret pattern/);
      }

      if (store.close) store.close();
    } finally {
      if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  test(`${backendName}: secret guard rejects sk- prefixed keys`, async (t) => {
    const testDir = createTestDir(backendName, 'secretsk');
    try {
      const store = backendName === 'sqlite' ? new SqliteWalStore({ directory: testDir }) : new AtomicFileStore({ directory: testDir });

      try {
        await store.put('openrouter', { model: 'gpt-4', api_url: 'https://openrouter.ai', _key: 'sk-' + 'x'.repeat(30) });
        assert.fail('Should have rejected sk- prefixed value');
      } catch (e) {
        assert.match(e.message, /SECURITY.*secret pattern/);
      }

      if (store.close) store.close();
    } finally {
      if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  test(`${backendName}: secret guard rejects ghp_ tokens`, async (t) => {
    const testDir = createTestDir(backendName, 'secretghp');
    try {
      const store = backendName === 'sqlite' ? new SqliteWalStore({ directory: testDir }) : new AtomicFileStore({ directory: testDir });

      try {
        await store.put('github', { token: 'ghp_' + 'A'.repeat(40) });
        assert.fail('Should have rejected ghp_ token');
      } catch (e) {
        assert.match(e.message, /SECURITY.*secret pattern/);
      }

      if (store.close) store.close();
    } finally {
      if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  test(`${backendName}: secret guard allows safe data including content hashes`, async (t) => {
    const testDir = createTestDir(backendName, 'safdata');
    try {
      const store = backendName === 'sqlite' ? new SqliteWalStore({ directory: testDir }) : new AtomicFileStore({ directory: testDir });

      const safeData = {
        sha256: 'a'.repeat(64),
        content_hash: 'b'.repeat(64),
        commit_hash: 'c'.repeat(64),
        idempotency_key: 'd'.repeat(64),
        text: 'This is a normal string',
        numbers: [1, 2, 3],
        nested: { data: 'value' },
      };

      await store.put('safe-key', safeData);
      const retrieved = await store.get('safe-key');
      assert.deepStrictEqual(retrieved, safeData);

      if (store.close) store.close();
    } finally {
      if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  test(`${backendName}: appendReceipt`, async (t) => {
    const testDir = createTestDir(backendName, 'receipt');
    try {
      const store = backendName === 'sqlite' ? new SqliteWalStore({ directory: testDir }) : new AtomicFileStore({ directory: testDir });

      const receipt = {
        timestamp: new Date().toISOString(),
        action: 'test-action',
        result: 'success',
        state: { shouldBeRemoved: true },
      };

      await store.appendReceipt(receipt);

      // Verify receipt was written (without the state field)
      if (backendName === 'atomic-file') {
        const date = new Date().toISOString().slice(0, 10);
        const receiptPath = path.join(testDir, 'receipts', `${date}.jsonl`);
        const content = fs.readFileSync(receiptPath, 'utf8');
        const line = content.trim().split('\n')[0];
        const parsed = JSON.parse(line);
        assert.ok(!parsed.state, 'state should be redacted from receipt');
        assert.strictEqual(parsed.action, 'test-action');
      }

      if (store.close) store.close();
    } finally {
      if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  test(`${backendName}: data persistence across store instances`, async (t) => {
    const testDir = createTestDir(backendName, 'persist');
    try {
      const store1 = backendName === 'sqlite' ? new SqliteWalStore({ directory: testDir }) : new AtomicFileStore({ directory: testDir });
      await store1.put('persistent-key', { value: 'persists' });
      if (store1.close) store1.close();

      // Create new store instance
      const store2 = backendName === 'sqlite' ? new SqliteWalStore({ directory: testDir }) : new AtomicFileStore({ directory: testDir });
      const retrieved = await store2.get('persistent-key');
      assert.deepStrictEqual(retrieved, { value: 'persists' });

      if (store2.close) store2.close();
    } finally {
      if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  test(`${backendName}: complex nested data structures`, async (t) => {
    const testDir = createTestDir(backendName, 'complex');
    try {
      const store = backendName === 'sqlite' ? new SqliteWalStore({ directory: testDir }) : new AtomicFileStore({ directory: testDir });

      const complexData = {
        recent_casts: [
          { text: 'cast 1', ts: '2026-01-01T00:00:00Z' },
          { text: 'cast 2', ts: '2026-01-02T00:00:00Z' },
        ],
        drafts: [
          { hash: 'abc', text: 'draft 1', parentFid: 123 },
          { hash: 'def', text: 'draft 2', parentFid: 456 },
        ],
        metadata: {
          lastSync: '2026-01-15T12:30:45Z',
          version: '1.0.0',
          nested: {
            deep: {
              data: 'here',
            },
          },
        },
      };

      await store.put('complex', complexData);
      const retrieved = await store.get('complex');
      assert.deepStrictEqual(retrieved, complexData);

      if (store.close) store.close();
    } finally {
      if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  // Restore test: write, corrupt (drop), restore from backup
  test(`${backendName}: restore from backup`, async (t) => {
    const testDir = createTestDir(backendName, 'restore');
    try {
      const store1 = backendName === 'sqlite' ? new SqliteWalStore({ directory: testDir }) : new AtomicFileStore({ directory: testDir });

      // Write initial data
      const originalData = { user: 'alice', status: 'active' };
      await store1.put('user-state', originalData);

      // Simulate backup by reading the state
      const beforeData = await store1.get('user-state');
      assert.deepStrictEqual(beforeData, originalData);

      if (store1.close) store1.close();

      // Simulate corruption by deleting the database/state files
      if (fs.existsSync(testDir)) {
        fs.rmSync(testDir, { recursive: true, force: true });
      }

      // Create directory again and try to get data - should be empty
      await fs.promises.mkdir(testDir, { recursive: true });
      const store2 = backendName === 'sqlite' ? new SqliteWalStore({ directory: testDir }) : new AtomicFileStore({ directory: testDir });
      const afterCorruption = await store2.get('user-state');
      assert.strictEqual(afterCorruption, undefined);

      // Now restore the data
      await store2.put('user-state', beforeData);
      const restored = await store2.get('user-state');
      assert.deepStrictEqual(restored, originalData);

      if (store2.close) store2.close();
    } finally {
      if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
    }
  });
}

// Run tests for each backend
(async () => {
  for (const backendName of BACKENDS_TO_TEST) {
    console.log(`\nTesting ${backendName} backend...`);
    await testBackend(backendName);
  }

  // Test Bonfire backend with mocks
  console.log('\nTesting Bonfire backend (with mock API)...');
  await testBonfireBackend();
})();

// Mock Bonfire API for testing
class MockBonfireAPI {
  constructor() {
    this.episodes = new Map();
    this.nextTaskId = 1;
  }

  async handleCreateEpisode(payload) {
    const taskId = String(this.nextTaskId++);
    this.episodes.set(payload.name, {
      uuid: crypto.randomUUID(),
      name: payload.name,
      episode_body: payload.episode_body,
      source_description: payload.source_description,
      created_at: new Date().toISOString(),
      content: payload.episode_body,
    });
    return { success: true, task_id: taskId };
  }

  async handleDelve(payload) {
    const episodes = Array.from(this.episodes.values()).filter((ep) => {
      if (payload.query.includes(ep.name)) return true;
      return payload.query.includes('zol-state');
    });
    return {
      success: true,
      query: payload.query,
      num_results: episodes.length,
      episodes: episodes,
    };
  }
}

// Override global fetch for Bonfire tests
let mockAPI;
const originalFetch = global.fetch;

function setupMockBonfireAPI() {
  mockAPI = new MockBonfireAPI();
  global.fetch = async (url, options) => {
    const body = JSON.parse(options.body);

    if (url.includes('/knowledge_graph/episode/create')) {
      const response = await mockAPI.handleCreateEpisode(body);
      return {
        ok: true,
        status: 200,
        json: async () => response,
        text: async () => JSON.stringify(response),
      };
    }

    if (url.includes('/delve')) {
      const response = await mockAPI.handleDelve(body);
      return {
        ok: true,
        status: 200,
        json: async () => response,
        text: async () => JSON.stringify(response),
      };
    }

    return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
  };
}

function teardownMockBonfireAPI() {
  global.fetch = originalFetch;
  mockAPI = null;
}

async function testBonfireBackend() {
  test('bonfire: initialize with credentials', async (t) => {
    const store = new BonfireStore({
      apiKey: 'test-key',
      bonfireId: 'test-id',
    });
    await store.initialize();
    assert.strictEqual(store.name, 'bonfire');
  });

  test('bonfire: initialize without credentials throws', async (t) => {
    const store = new BonfireStore({});
    try {
      await store.initialize();
      assert.fail('Should have thrown');
    } catch (e) {
      assert.match(e.message, /BONFIRE_API_KEY.*BONFIRE_ID/);
    }
  });

  test('bonfire: put and get round-trip', async (t) => {
    setupMockBonfireAPI();
    try {
      const store = new BonfireStore({
        apiKey: 'test-key',
        bonfireId: 'test-id',
      });

      const testData = { foo: 'bar', num: 42 };
      await store.put('test-key', testData);
      const retrieved = await store.get('test-key');
      assert.deepStrictEqual(retrieved, testData);
    } finally {
      teardownMockBonfireAPI();
    }
  });

  test('bonfire: get non-existent key returns undefined', async (t) => {
    setupMockBonfireAPI();
    try {
      const store = new BonfireStore({
        apiKey: 'test-key',
        bonfireId: 'test-id',
      });

      const retrieved = await store.get('does-not-exist');
      assert.strictEqual(retrieved, undefined);
    } finally {
      teardownMockBonfireAPI();
    }
  });

  test('bonfire: list keys', async (t) => {
    setupMockBonfireAPI();
    try {
      const store = new BonfireStore({
        apiKey: 'test-key',
        bonfireId: 'test-id',
      });

      await store.put('key1', { val: 1 });
      await store.put('key2', { val: 2 });

      const keys = await store.list();
      assert.ok(keys.length >= 2);
      assert.ok(keys.includes('key1') || keys.some((k) => k.includes('key1')));
    } finally {
      teardownMockBonfireAPI();
    }
  });

  test('bonfire: delete returns false (unsupported)', async (t) => {
    setupMockBonfireAPI();
    try {
      const store = new BonfireStore({
        apiKey: 'test-key',
        bonfireId: 'test-id',
      });

      const result = await store.delete('some-key');
      assert.strictEqual(result, false);
    } finally {
      teardownMockBonfireAPI();
    }
  });

  test('bonfire: secret guard allows sha256 hashes (evidence)', async (t) => {
    setupMockBonfireAPI();
    try {
      const store = new BonfireStore({ apiKey: 'test-key', bonfireId: 'test-id' });
      const hashValue = 'a'.repeat(64);
      await store.put('receipt', { sha256: hashValue, content_hash: hashValue });
      const retrieved = await store.get('receipt');
      assert.strictEqual(retrieved.sha256, hashValue, 'SHA-256 hash must survive round-trip');
    } finally {
      teardownMockBonfireAPI();
    }
  });

  test('bonfire: secret guard rejects hex in credential-named fields', async (t) => {
    setupMockBonfireAPI();
    try {
      const store = new BonfireStore({ apiKey: 'test-key', bonfireId: 'test-id' });
      try {
        await store.put('keys', { private_key: 'a'.repeat(64) });
        assert.fail('Should have rejected hex in private_key field');
      } catch (e) {
        assert.match(e.message, /SECURITY.*secret pattern/);
      }
    } finally {
      teardownMockBonfireAPI();
    }
  });

  test('bonfire: secret guard rejects sk- keys', async (t) => {
    setupMockBonfireAPI();
    try {
      const store = new BonfireStore({ apiKey: 'test-key', bonfireId: 'test-id' });
      try {
        await store.put('secret', { _key: 'sk-' + 'x'.repeat(30) });
        assert.fail('Should have rejected sk- key');
      } catch (e) {
        assert.match(e.message, /SECURITY.*secret pattern/);
      }
    } finally {
      teardownMockBonfireAPI();
    }
  });

  test('bonfire: secret guard rejects ghp_ tokens', async (t) => {
    setupMockBonfireAPI();
    try {
      const store = new BonfireStore({ apiKey: 'test-key', bonfireId: 'test-id' });
      try {
        await store.put('secret', { token: 'ghp_' + 'A'.repeat(40) });
        assert.fail('Should have rejected ghp_ token');
      } catch (e) {
        assert.match(e.message, /SECURITY.*secret pattern/);
      }
    } finally {
      teardownMockBonfireAPI();
    }
  });

  test('bonfire: allows safe data', async (t) => {
    setupMockBonfireAPI();
    try {
      const store = new BonfireStore({
        apiKey: 'test-key',
        bonfireId: 'test-id',
      });

      const safeData = { text: 'safe content', num: 123 };
      await store.put('safe-key', safeData);
      const retrieved = await store.get('safe-key');
      assert.deepStrictEqual(retrieved, safeData);
    } finally {
      teardownMockBonfireAPI();
    }
  });

  test('bonfire: appendReceipt (best-effort)', async (t) => {
    setupMockBonfireAPI();
    try {
      const store = new BonfireStore({
        apiKey: 'test-key',
        bonfireId: 'test-id',
      });

      const receipt = {
        timestamp: new Date().toISOString(),
        action: 'test',
        state: { hidden: true },
      };

      // Should not throw even if mock doesn't verify receipt
      await store.appendReceipt(receipt);
    } finally {
      teardownMockBonfireAPI();
    }
  });

  test('bonfire: backend selection in createStateStore', async (t) => {
    setupMockBonfireAPI();
    try {
      process.env.ZOL_STATE_BACKEND = 'bonfire';
      process.env.BONFIRE_API_KEY = 'test-key';
      process.env.BONFIRE_ID = 'test-id';

      const store = await createStateStore();
      assert.strictEqual(store.name, 'bonfire');

      delete process.env.ZOL_STATE_BACKEND;
      delete process.env.BONFIRE_API_KEY;
      delete process.env.BONFIRE_ID;
    } finally {
      teardownMockBonfireAPI();
    }
  });

  test('bonfire: createStateStore fails closed on missing credentials (no silent fallback)', async (t) => {
    try {
      process.env.ZOL_STATE_BACKEND = 'bonfire';
      delete process.env.BONFIRE_API_KEY;
      delete process.env.BONFIRE_ID;

      try {
        await createStateStore();
        assert.fail('Should have thrown StateStoreInitError');
      } catch (e) {
        assert.strictEqual(e.code, 'STATE_STORE_INIT_FAILED', 'must throw StateStoreInitError');
        assert.strictEqual(e.backend, 'bonfire');
      }
    } finally {
      delete process.env.ZOL_STATE_BACKEND;
    }
  });

  test('bonfire: createStateStore accepts options object', async (t) => {
    setupMockBonfireAPI();
    try {
      process.env.BONFIRE_API_KEY = 'test-key';
      process.env.BONFIRE_ID = 'test-id';
      const store = await createStateStore({ backend: 'bonfire' });
      assert.strictEqual(store.name, 'bonfire');
    } finally {
      delete process.env.BONFIRE_API_KEY;
      delete process.env.BONFIRE_ID;
      teardownMockBonfireAPI();
    }
  });
}
