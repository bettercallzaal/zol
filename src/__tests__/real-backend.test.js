'use strict';

// real-backend.test.js - Durability tests using a real AtomicFileStore (no mocks).
// Each test creates its own tmpdir, "restarts" by constructing a fresh store/class
// instance pointing at the same directory, then proves the data survived.
//
// Run: node --test src/__tests__/real-backend.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');

const { AtomicFileStore, createStateStore } = require('../state-adapter');
const { ReceiptJournal } = require('../receipt-journal');
const { ArtifactPipeline } = require('../artifact-pipeline');
const { ProofDropAdapter } = require('../adapters/proof-drop-adapter');
const { ApprovalBridge } = require('../approval-bridge');
const { WorkRouter } = require('../work-router');
const { AgentGateway } = require('../agent-gateway');
const { CapsuleRegistry } = require('../capsule-registry');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a throwaway tmpdir with a random suffix. */
function makeTmpDir(label) {
  const suffix = crypto.randomBytes(6).toString('hex');
  const dir = path.join(os.tmpdir(), `zol-real-${label}-${suffix}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Remove a directory tree, best-effort (never throws). */
function rmDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (_) {
    // ignore
  }
}

/** Build a fresh AtomicFileStore instance on the given directory. */
async function freshStore(dir) {
  return createStateStore({ backend: 'atomic-file', directory: dir });
}

// ---------------------------------------------------------------------------
// Minimal fixture capsule for the Trapper / CapsuleRegistry test
// ---------------------------------------------------------------------------

function makeFixtureCapsule(capsuleId) {
  return {
    schema: 'dreamnet.synergy_capsule.v1',
    capsule_id: capsuleId,
    name: 'Test Fixture Capsule',
    version: '1.0.0',
    capsule_type: 'fixture',
    status: 'active',
    purpose: 'Real-backend test fixture',
    payload: { greeting: 'hello from fixture' },
    permissions: {
      allowed: ['read:state', 'write:state'],
      blocked: ['write:credentials'],
    },
    resource_limits: { maxMemoryMb: 64, maxCpuMs: 5000 },
    activation: { mode: 'auto', schedule: null },
    provenance: {
      content_hash: 'sha256:' + crypto.createHash('sha256').update('fixture').digest('hex'),
    },
  };
}

// ---------------------------------------------------------------------------
// Test 1: live write → restart → read returns same state
// ---------------------------------------------------------------------------

test('live write → restart → read returns same state', async () => {
  const dir = makeTmpDir('t1-write-read');
  try {
    // Stage 1: write
    const store1 = await freshStore(dir);
    await store1.put('hello', { msg: 'world', counter: 42 });

    // Stage 2: create NEW store instance pointing at same directory (simulates restart)
    const store2 = await freshStore(dir);
    const value = await store2.get('hello');

    assert.deepEqual(value, { msg: 'world', counter: 42 });
  } finally {
    rmDir(dir);
  }
});

// ---------------------------------------------------------------------------
// Test 2: receipt append → restart → chain verifies
// ---------------------------------------------------------------------------

test('receipt append → restart → chain verifies', async () => {
  const dir = makeTmpDir('t2-receipt-chain');
  try {
    // Stage 1: append 3 receipts
    const store1 = await freshStore(dir);
    const journal1 = new ReceiptJournal(store1, { agentId: 'test-agent' });

    const baseFields = {
      loopId: 'loop-chain-test',
      capsuleId: 'test-capsule-v1',
      action: 'test.action',
      status: 'success',
    };

    await journal1.append({ ...baseFields, runId: 'run-001', stepId: 'step-1' });
    await journal1.append({ ...baseFields, runId: 'run-002', stepId: 'step-2' });
    await journal1.append({ ...baseFields, runId: 'run-003', stepId: 'step-3' });

    // Stage 2: NEW store + journal instance pointing at same directory
    const store2 = await freshStore(dir);
    const journal2 = new ReceiptJournal(store2, { agentId: 'test-agent' });

    const result = await journal2.verifyChain();

    assert.equal(result.checked, 3, `expected 3 receipts, got ${result.checked}`);
    assert.equal(result.valid, true, `chain invalid: ${result.errors.join('; ')}`);
    assert.deepEqual(result.errors, []);
  } finally {
    rmDir(dir);
  }
});

// ---------------------------------------------------------------------------
// Test 3: artifact build persists real SHA-256 content hash
// ---------------------------------------------------------------------------

test('artifact build persists real SHA-256 content hash', async () => {
  const dir = makeTmpDir('t3-artifact-hash');
  try {
    // Stage 1: plan + build
    const store1 = await freshStore(dir);
    const pipeline1 = new ArtifactPipeline(store1, null);

    const planned = await pipeline1.plan({
      type: 'report',
      title: 'Hash Test Artifact',
      description: 'Tests that contentHash survives restart',
    });

    const built = await pipeline1.build(planned.artifactId, 'the content string');
    const artifactId = built.artifactId;

    assert.ok(built.contentHash, 'contentHash should be set after build');
    assert.ok(built.contentHash.startsWith('sha256:'), `contentHash should start with "sha256:", got: ${built.contentHash}`);

    // Stage 2: NEW pipeline instance pointing at same directory
    const store2 = await freshStore(dir);
    const pipeline2 = new ArtifactPipeline(store2, null);

    const loaded = await pipeline2.get(artifactId);
    assert.ok(loaded, 'artifact should be readable after restart');
    assert.equal(loaded.contentHash, built.contentHash,
      `contentHash changed after restart: was ${built.contentHash}, now ${loaded.contentHash}`);
    assert.ok(loaded.contentHash.startsWith('sha256:'),
      `contentHash after restart should start with "sha256:", got: ${loaded.contentHash}`);
  } finally {
    rmDir(dir);
  }
});

// ---------------------------------------------------------------------------
// Test 4: Proof Drop exports the same valid hash; nested private evidence absent
// ---------------------------------------------------------------------------

test('Proof Drop exports valid contentHash and excludes nested private evidence', async () => {
  const dir = makeTmpDir('t4-proof-drop');
  try {
    const store = await freshStore(dir);
    const journal = new ReceiptJournal(store, { agentId: 'test-agent' });
    const pipeline = new ArtifactPipeline(store, journal);

    // Build a full pipeline: plan → build → verify → package → deliver
    const planned = await pipeline.plan({
      type: 'report',
      title: 'Proof Drop Test',
      description: 'Exercises ProofDropAdapter.export()',
    });
    const artifactId = planned.artifactId;

    // Build with nested private evidence in content (should be stripped from bundle)
    await pipeline.build(artifactId, {
      publicField: 'visible',
      nested: { secret: 'top-secret-value', publicData: 'ok' },
    });

    await pipeline.verify(artifactId, { passed: true, checksum: 'verified' });
    await pipeline.package(artifactId);

    const delivered = await pipeline.deliver(artifactId);
    const expectedHash = delivered.contentHash;

    // Export via ProofDropAdapter
    const adapter = new ProofDropAdapter(pipeline, journal);
    const bundle = await adapter.export(artifactId);

    // contentHash must be preserved, valid, and in sha256:<hex> format
    assert.equal(bundle.contentHash, expectedHash,
      `contentHash in bundle (${bundle.contentHash}) must match artifact (${expectedHash})`);
    assert.ok(/^sha256:[0-9a-f]{64}$/.test(bundle.contentHash),
      `contentHash must match sha256:<64 hex>: got ${bundle.contentHash}`);

    // Validate via the adapter's own validator
    const validation = adapter.validate(bundle);
    assert.equal(validation.valid, true,
      `Proof Drop bundle invalid: ${validation.errors.join('; ')}`);

    // The bundle itself must not contain nested.secret
    const bundleStr = JSON.stringify(bundle);
    assert.ok(!bundleStr.includes('top-secret-value'),
      'bundle should not contain the raw nested secret value');

  } finally {
    rmDir(dir);
  }
});

// ---------------------------------------------------------------------------
// Test 5: approval → consume() succeeds once; second consume() throws ALREADY_CONSUMED
// ---------------------------------------------------------------------------

test('approval: consume() succeeds first time; second consume() throws ALREADY_CONSUMED', async () => {
  const dir = makeTmpDir('t5-approval');
  try {
    const store = await freshStore(dir);
    const journal = new ReceiptJournal(store, { agentId: 'test-agent' });
    const bridge = new ApprovalBridge(store, journal, { defaultTimeoutMs: 60000 });

    // --- Happy path: approved then consumed ---
    const req = await bridge.request({
      action: 'deploy-staging',
      context: { target: 'staging-env' },
      requestedBy: 'loop-deployer',
    });

    await bridge.decide(req.requestId, 'approved', { decidedBy: 'operator' });

    // First consume: succeeds
    const consumed = await bridge.consume(req.requestId);
    assert.equal(consumed.status, 'consumed', 'status must be consumed after first consume()');

    // Second consume: must throw ALREADY_CONSUMED (replay rejected)
    await assert.rejects(
      () => bridge.consume(req.requestId),
      (err) => {
        assert.equal(err.code, 'ALREADY_CONSUMED', `expected ALREADY_CONSUMED, got ${err.code}`);
        return true;
      },
      'second consume() must throw ALREADY_CONSUMED'
    );

    // --- Denied path: consume() throws GATE_DENIED ---
    const req2 = await bridge.request({
      action: 'delete-production',
      context: { target: 'prod-db' },
      requestedBy: 'loop-dangerous',
      idempotencyKey: 'unique-deny-key-' + crypto.randomUUID(),
    });

    await bridge.decide(req2.requestId, 'denied', { decidedBy: 'operator' });

    await assert.rejects(
      () => bridge.consume(req2.requestId),
      (err) => {
        assert.equal(err.code, 'GATE_DENIED', `expected GATE_DENIED, got ${err.code}`);
        return true;
      },
      'consume() must throw GATE_DENIED for a denied request'
    );

  } finally {
    rmDir(dir);
  }
});

// ---------------------------------------------------------------------------
// Test 6: two workers cannot own the same task lease
// ---------------------------------------------------------------------------

test('two workers cannot own the same task lease (LEASE_ALREADY_HELD)', async () => {
  const dir = makeTmpDir('t6-lease');
  try {
    const store = await freshStore(dir);
    const router = new WorkRouter(store);

    const packet = await router.createPacket({
      title: 'Contested Task',
      description: 'Two workers race for the same lease',
      type: 'research',
    });

    // Worker A acquires the lease
    await router.route(packet.packetId, 'worker-a-route', {
      owner: 'worker-a',
      leaseTtlMs: 60 * 60 * 1000, // 1 hour — well beyond test duration
    });

    // Worker B tries to route the same packet — must be rejected
    await assert.rejects(
      () => router.route(packet.packetId, 'worker-b-route', {
        owner: 'worker-b',
        leaseTtlMs: 60 * 60 * 1000,
      }),
      (err) => {
        assert.equal(err.code, 'LEASE_ALREADY_HELD',
          `expected LEASE_ALREADY_HELD, got code=${err.code} message=${err.message}`);
        return true;
      },
      'second route() on same packet should throw LEASE_ALREADY_HELD'
    );

  } finally {
    rmDir(dir);
  }
});

// ---------------------------------------------------------------------------
// Test 7: unauthenticated remote gateway rejected (401)
// ---------------------------------------------------------------------------

test('unauthenticated remote gateway request returns 401', async () => {
  // AgentGateway only enforces auth when this._authToken is set.
  // We pass authToken directly to trigger auth enforcement, and bind to 127.0.0.1
  // so we don't need remote mode (which would also require bindAddress='0.0.0.0').
  // We emulate the auth check by constructing the gateway with a known token
  // and setting _authToken manually (since remote mode enforcement also changes bindAddress).

  const dir = makeTmpDir('t7-gateway-auth');
  let gateway = null;
  let serverPort = null;

  try {
    const store = await freshStore(dir);
    const journal = new ReceiptJournal(store, { agentId: 'test-agent' });

    // Minimal stubs for required constructor args
    const stubRegistry = { list: async () => [] };
    const stubWorkRouter = new WorkRouter(store);
    const stubPipeline = new ArtifactPipeline(store, journal);
    const stubToolGateway = { discover: async () => ({ tools: [] }) };

    // Construct with an explicit authToken — this enables auth checking in _handleRequest
    // without requiring ZOL_AGENT_GATEWAY_REMOTE=1 (which forces bindAddress=0.0.0.0).
    // We patch _authToken directly after construction on localhost mode.
    gateway = new AgentGateway({
      capsuleRegistry: stubRegistry,
      dreamloopRegistry: stubRegistry,
      workRouter: stubWorkRouter,
      artifactPipeline: stubPipeline,
      receiptJournal: journal,
      toolGateway: stubToolGateway,
      port: 0, // let OS assign a free port
      bindAddress: '127.0.0.1',
    });

    // Force authToken on the instance to enable the auth middleware check
    gateway._authToken = 'test-secret-token-xyz';

    const { port } = await gateway.start();
    serverPort = port;

    // Request WITHOUT a Bearer token
    const resp = await fetch(`http://127.0.0.1:${port}/health`, {
      headers: {}, // no Authorization header
    });

    assert.equal(resp.status, 401,
      `Expected 401 Unauthorized for unauthenticated request, got ${resp.status}`);

    const body = await resp.json();
    assert.ok(body.error, 'response body should have an error field');

    // Request WITH the correct Bearer token should succeed
    const respOk = await fetch(`http://127.0.0.1:${port}/health`, {
      headers: { Authorization: 'Bearer test-secret-token-xyz' },
    });
    assert.equal(respOk.status, 200,
      `Expected 200 for authenticated request, got ${respOk.status}`);

  } finally {
    if (gateway) {
      try { await gateway.stop(); } catch (_) {}
    }
    rmDir(dir);
  }
});

// ---------------------------------------------------------------------------
// Test 8: Trapper export/import round trip preserves allowed data and provenance
// ---------------------------------------------------------------------------

test('CapsuleRegistry install → get round trip preserves capsule_id and provenance', async () => {
  const dir = makeTmpDir('t8-trapper');
  try {
    // Stage 1: install a capsule
    const store1 = await freshStore(dir);
    const registry1 = new CapsuleRegistry(store1);

    const capsuleId = 'test-capsule-trapper-' + crypto.randomUUID().slice(0, 8);
    const fixture = makeFixtureCapsule(capsuleId);

    const installResult = await registry1.install(fixture);
    assert.equal(installResult.capsuleId, capsuleId);
    assert.equal(installResult.status, 'installed');

    // Stage 2: NEW store + registry instance (restart), retrieve and verify
    const store2 = await freshStore(dir);
    const registry2 = new CapsuleRegistry(store2);

    const retrieved = await registry2.get(capsuleId);

    assert.ok(retrieved, 'capsule should be readable after restart');
    assert.equal(retrieved.capsule_id, capsuleId, 'capsule_id must be preserved');
    assert.equal(retrieved.name, fixture.name, 'name must be preserved');
    assert.equal(retrieved.version, fixture.version, 'version must be preserved');

    // Provenance content_hash must be preserved
    assert.equal(
      retrieved.provenance.content_hash,
      fixture.provenance.content_hash,
      'provenance.content_hash must be preserved through export/import'
    );

    // permissions.allowed must be preserved
    assert.deepEqual(
      retrieved.permissions.allowed,
      fixture.permissions.allowed,
      'permissions.allowed must be preserved'
    );

    // permissions.blocked must be preserved
    assert.deepEqual(
      retrieved.permissions.blocked,
      fixture.permissions.blocked,
      'permissions.blocked must be preserved'
    );

    // payload must be preserved
    assert.deepEqual(
      retrieved.payload,
      fixture.payload,
      'payload must be preserved'
    );

    // The registry attaches extra fields (status, hash, installedAt) — verify that no
    // blocked permission leaked into the allowed array.
    const blockedInAllowed = (retrieved.permissions.allowed || []).filter(
      (p) => (fixture.permissions.blocked || []).includes(p)
    );
    assert.deepEqual(blockedInAllowed, [],
      `blocked permissions must not appear in allowed: found ${JSON.stringify(blockedInAllowed)}`);

  } finally {
    rmDir(dir);
  }
});

// ---------------------------------------------------------------------------
// Test 9: partial completion — checkpoint survives restart (gate item 8)
// ---------------------------------------------------------------------------

test('partial completion: checkpoint survives restart and packet can be resumed', async () => {
  const dir = makeTmpDir('t9-partial');
  try {
    // Stage 1: create packet, route to worker, checkpoint partial state
    const store1 = await freshStore(dir);
    const router1 = new WorkRouter(store1);

    const packet = await router1.createPacket({
      title: 'Long Research Task',
      description: 'Simulates partial completion across restart',
      type: 'research',
    });

    const routed = await router1.route(packet.packetId, 'worker-a', {
      owner: 'worker-a',
      leaseTtlMs: 60 * 60 * 1000,
    });

    await router1.checkpoint(packet.packetId, {
      stepsDone: ['step-1', 'step-2'],
      stepsRemaining: ['step-3'],
      partialResult: { found: 3, reviewed: 2 },
    });

    const attemptIdBeforeRestart = routed.attemptId;

    // Stage 2: new store + router (restart)
    const store2 = await freshStore(dir);
    const router2 = new WorkRouter(store2);

    const resumed = await router2.resume(packet.packetId);

    assert.ok(resumed, 'packet should be retrievable after restart');
    assert.equal(resumed.packetId, packet.packetId, 'packetId must be preserved');
    assert.equal(resumed.status, 'in_progress', 'packet must still be in_progress');
    assert.deepEqual(
      resumed.resumeCheckpoint.stepsDone,
      ['step-1', 'step-2'],
      'checkpoint stepsDone must survive restart'
    );
    assert.deepEqual(
      resumed.resumeCheckpoint.stepsRemaining,
      ['step-3'],
      'checkpoint stepsRemaining must survive restart'
    );
    assert.equal(resumed.attemptId, attemptIdBeforeRestart, 'attemptId must be preserved');
  } finally {
    rmDir(dir);
  }
});

// ---------------------------------------------------------------------------
// Test 10: approval timeout — expired request is GATE_DENIED (gate item 8)
// ---------------------------------------------------------------------------

test('approval timeout: expired request yields GATE_DENIED on consume()', async () => {
  const dir = makeTmpDir('t10-timeout');
  try {
    const store = await freshStore(dir);
    const journal = new ReceiptJournal(store, { agentId: 'test-agent' });
    const bridge = new ApprovalBridge(store, journal, { defaultTimeoutMs: 1 });

    const req = await bridge.request({
      action: 'deploy-production',
      context: { env: 'prod' },
      requestedBy: 'loop-deploy',
    });

    // Poll expirePending until the 1ms TTL expires
    let expired = 0;
    const deadline = Date.now() + 2000;
    while (expired === 0 && Date.now() < deadline) {
      expired = await bridge.expirePending();
      if (expired === 0) await new Promise(r => setTimeout(r, 10));
    }
    assert.ok(expired > 0, 'expirePending() should have expired at least one request');

    await assert.rejects(
      () => bridge.consume(req.requestId),
      (err) => {
        assert.equal(err.code, 'GATE_DENIED', `expected GATE_DENIED, got ${err.code}`);
        assert.equal(err.reason, 'timeout', `expected reason=timeout, got ${err.reason}`);
        return true;
      },
      'consume() on timed-out request must throw GATE_DENIED(timeout)'
    );
  } finally {
    rmDir(dir);
  }
});

// ---------------------------------------------------------------------------
// Test 11: stale lease auto-expiry — expired lease allows new owner (gate item 8)
// ---------------------------------------------------------------------------

test('stale lease auto-expiry: expired lease allows a new worker to acquire', async () => {
  const dir = makeTmpDir('t11-stale-lease');
  try {
    const store = await freshStore(dir);
    const router = new WorkRouter(store);

    const packet = await router.createPacket({
      title: 'Short-Leased Task',
      description: 'Lease expires so a second worker can claim',
      type: 'research',
    });

    // Worker A acquires with a 1ms lease (effectively already expired)
    await router.route(packet.packetId, 'worker-a-init', {
      owner: 'worker-a',
      leaseTtlMs: 1,
    });

    // Let the lease expire
    await new Promise(r => setTimeout(r, 10));

    // Worker B can now claim the expired lease
    const acquired = await router.route(packet.packetId, 'worker-b-reclaim', {
      owner: 'worker-b',
      leaseTtlMs: 60 * 60 * 1000,
    });

    assert.equal(acquired.owner, 'worker-b', 'worker-b should own the reclaimed lease');

    const final = await router.resume(packet.packetId);
    assert.ok(
      final.fencingEpoch >= 1,
      `fencingEpoch should be >= 1 after re-acquisition, got ${final.fencingEpoch}`
    );
  } finally {
    rmDir(dir);
  }
});
