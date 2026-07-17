'use strict';
// Tests for durable-execution hardening (PR #35):
//   1. IdempotencyStore — in-memory dedup with TTL
//   2. ToolGateway idempotencyKey — duplicate consequential calls return cached result
//   3. WorkRouter sideEffectKey — auto-generated on every packet
//   4. board.task.claim handler — conditional claim prevents double-start
//
// No external network calls. All board operations use mock CoworkTracker responses.

const { describe, test, before, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { IdempotencyStore, DEFAULT_TTL_MS } = require('../idempotency-store');

// ---------------------------------------------------------------------------
// 1. IdempotencyStore
// ---------------------------------------------------------------------------

describe('IdempotencyStore', () => {
  let store;
  before(() => { store = new IdempotencyStore(); });

  test('check returns null for unknown key', () => {
    assert.strictEqual(store.check('no-such-key'), null);
  });

  test('check returns null when key is null/undefined', () => {
    assert.strictEqual(store.check(null), null);
    assert.strictEqual(store.check(undefined), null);
  });

  test('store then check returns the result', () => {
    store.store('key-abc', { output: { done: true }, receiptId: 'r1' });
    const hit = store.check('key-abc');
    assert.ok(hit);
    assert.deepEqual(hit.result, { output: { done: true }, receiptId: 'r1' });
    assert.ok(hit.cachedAt);
  });

  test('size reflects live entries', () => {
    const s = new IdempotencyStore();
    assert.strictEqual(s.size, 0);
    s.store('x', { output: 1 });
    assert.strictEqual(s.size, 1);
  });

  test('expired entry returns null after TTL', () => {
    const s = new IdempotencyStore();
    // Store with 1ms TTL then manipulate the stored expiresAt to be in the past
    s.store('k', { output: 42 }, 60000);
    // Force-expire the entry
    s._map.get('k').expiresAt = Date.now() - 1;
    assert.strictEqual(s.check('k'), null);
  });

  test('prune() removes expired entries', () => {
    const s = new IdempotencyStore();
    s.store('alive', { output: 1 }, 60000);
    s.store('dead', { output: 2 }, 0);
    s.prune();
    assert.ok(s.check('alive'));
    assert.strictEqual(s.check('dead'), null);
  });

  test('store without key is a no-op', () => {
    const s = new IdempotencyStore();
    s.store(null, { output: 1 });
    assert.strictEqual(s.size, 0);
  });

  test('DEFAULT_TTL_MS is 24 hours', () => {
    assert.strictEqual(DEFAULT_TTL_MS, 24 * 60 * 60 * 1000);
  });
});

// ---------------------------------------------------------------------------
// 2. ToolGateway idempotencyKey
// ---------------------------------------------------------------------------

describe('ToolGateway idempotencyKey dedup', () => {
  const { IdempotencyStore } = require('../idempotency-store');
  const { ToolGateway } = require('../tool-gateway');

  let gateway;
  let callCount;

  before(() => {
    callCount = 0;
    const idem = new IdempotencyStore();
    gateway = new ToolGateway(null, null, { idempotencyStore: idem });
    gateway.register({
      toolId: 'test.write',
      name: 'test.write',
      requiredPermission: 'test.write',
      isConsequential: true,
      handler: async () => {
        callCount++;
        return { written: callCount };
      },
    });
  });

  test('first call executes handler and returns result', async () => {
    const r = await gateway.execute('test.write', {}, {
      grantedPermissions: ['test.write'],
      idempotencyKey: 'idem-001',
    });
    assert.equal(r.output.written, 1);
    assert.strictEqual(r.idempotent, undefined);
  });

  test('second call with same key returns cached result without calling handler', async () => {
    const r = await gateway.execute('test.write', {}, {
      grantedPermissions: ['test.write'],
      idempotencyKey: 'idem-001',
    });
    assert.equal(r.output.written, 1);   // same value as first call
    assert.strictEqual(r.idempotent, true);
    assert.equal(callCount, 1);           // handler only called once
  });

  test('different key executes handler again', async () => {
    const r = await gateway.execute('test.write', {}, {
      grantedPermissions: ['test.write'],
      idempotencyKey: 'idem-002',
    });
    assert.equal(r.output.written, 2);
    assert.strictEqual(r.idempotent, undefined);
    assert.equal(callCount, 2);
  });

  test('read-only tool (non-consequential) is never cached', async () => {
    let reads = 0;
    gateway.register({
      toolId: 'test.read',
      name: 'test.read',
      requiredPermission: 'test.read',
      isConsequential: false,
      handler: async () => { reads++; return { n: reads }; },
    });
    await gateway.execute('test.read', {}, {
      grantedPermissions: ['test.read'],
      idempotencyKey: 'read-key',
    });
    await gateway.execute('test.read', {}, {
      grantedPermissions: ['test.read'],
      idempotencyKey: 'read-key',
    });
    assert.equal(reads, 2);
  });

  test('no idempotencyKey = no caching, handler runs every time', async () => {
    const before = callCount;
    await gateway.execute('test.write', {}, { grantedPermissions: ['test.write'] });
    await gateway.execute('test.write', {}, { grantedPermissions: ['test.write'] });
    assert.equal(callCount, before + 2);
  });
});

// ---------------------------------------------------------------------------
// 3. WorkRouter sideEffectKey auto-generation
// ---------------------------------------------------------------------------

describe('WorkRouter sideEffectKey', () => {
  const { WorkRouter } = require('../work-router');
  const { createStateStore } = require('../state-adapter');

  let router;
  before(async () => {
    const store = await createStateStore({ backend: 'atomic-file', dir: require('os').tmpdir() });
    router = new WorkRouter(store);
  });

  test('createPacket sets sideEffectKey when not supplied', async () => {
    const p = await router.createPacket({
      title: 'Auto-key test',
      description: 'should auto-generate sideEffectKey',
      type: 'other',
    });
    assert.ok(p.sideEffectKey, 'sideEffectKey must be set');
    assert.match(p.sideEffectKey, /^[0-9a-f-]{36}$/, 'must be a UUID');
  });

  test('createPacket preserves caller-supplied sideEffectKey', async () => {
    const key = 'my-custom-key-xyz';
    const p = await router.createPacket({
      title: 'Custom key test',
      description: 'd',
      type: 'other',
      sideEffectKey: key,
    });
    assert.equal(p.sideEffectKey, key);
  });

  test('two packets get different auto-generated keys', async () => {
    const p1 = await router.createPacket({ title: 'A', description: 'd', type: 'other' });
    const p2 = await router.createPacket({ title: 'B', description: 'd', type: 'other' });
    assert.notEqual(p1.sideEffectKey, p2.sideEffectKey);
  });
});

// ---------------------------------------------------------------------------
// 4. board.task.claim — collision prevention (mock CoworkTracker)
// ---------------------------------------------------------------------------

describe('board.task.claim — conditional claim', () => {
  // We test the claimTask method on a mock CoworkTracker directly,
  // since the board handler is a thin pass-through.
  // The real Supabase conditional PATCH is tested by integration; here we verify
  // the contract: empty row set → collision: true.

  const { CoworkTracker } = require('../cowork-tracker');

  function makeMockTracker(rowsToReturn) {
    const tracker = new CoworkTracker({ url: 'http://mock', key: 'mock-key' });
    tracker._req = async () => ({ ok: true, data: rowsToReturn });
    return tracker;
  }

  test('claimTask returns ok:true when row is returned (claim succeeded)', async () => {
    const tracker = makeMockTracker([{ id: 'abc', status: 'in_progress' }]);
    const result = await tracker.claimTask('abc', 'claiming it');
    assert.equal(result.ok, true);
    assert.equal(result.row.status, 'in_progress');
    assert.strictEqual(result.collision, undefined);
  });

  test('claimTask returns collision:true when no rows returned (another agent claimed it)', async () => {
    const tracker = makeMockTracker([]);  // empty → condition not met
    const result = await tracker.claimTask('abc', 'trying to claim');
    assert.equal(result.ok, false);
    assert.equal(result.collision, true);
  });

  test('claimTask passes fromStatus in URL filter', async () => {
    let capturedPath = '';
    const tracker = new CoworkTracker({ url: 'http://mock', key: 'key' });
    tracker._req = async (method, path) => { capturedPath = path; return { ok: true, data: [{ id: 'x' }] }; };
    await tracker.claimTask('task-1', null, { fromStatus: 'pending' });
    assert.ok(capturedPath.includes('status=eq.pending'), `path must include status filter: ${capturedPath}`);
  });

  test('board.task.claim handler delegates to claimTask', async () => {
    const { handlers } = require('../handlers/board-handlers');
    assert.equal(typeof handlers['board.task.claim'], 'function');
    // No id → error response
    const r = await handlers['board.task.claim']({ input: {} });
    assert.equal(r.ok, false);
    assert.ok(r.error.includes('id is required'));
  });
});
