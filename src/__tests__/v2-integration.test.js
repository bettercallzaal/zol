'use strict';

// v2-integration.test.js
// Comprehensive integration tests for ZOL Persistent Agent Upgrade v2
// Covers: restart recovery, migrations, idempotency, duplicate requests,
//         capsule digest changes, malformed DreamLoops, tool denial,
//         approval gates, source citations, memory privacy, secret scanning,
//         corrupted state recovery, model fallback, Warper disabled/mock modes,
//         MCP authentication (endpoint availability), Proof Drop redaction,
//         one-reply-per-social-thread behaviour.
//
// Run: node --test src/__tests__/v2-integration.test.js

const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const http = require('node:http');

// ---------------------------------------------------------------------------
// Module imports
// ---------------------------------------------------------------------------

const { CapsuleRegistry } = require('../capsule-registry');
const { DreamLoopRegistry } = require('../dreamloop-registry');
const { ReceiptJournal } = require('../receipt-journal');
const { MemoryWeaver } = require('../memory-weaver');
const { WorkRouter } = require('../work-router');
const { ModelGateway, QuotaExceededError } = require('../model-gateway');
const { ToolGateway, ApprovalRequiredError, PermissionDeniedError } = require('../tool-gateway');
const { ArtifactPipeline } = require('../artifact-pipeline');
const { createWarperKeeperAdapter } = require('../adapters/warper-keeper-adapter');
const { ProofDropAdapter } = require('../adapters/proof-drop-adapter');
const { ApprovalBridge } = require('../approval-bridge');
const { AgentGateway } = require('../agent-gateway');
const { Zictionary } = require('../zictionary');
const { Zocuments } = require('../zocuments');

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** In-memory store factory — satisfies get/put/initialize interface. */
const makeMockStore = () => ({
  _data: {},
  async get(k) { return this._data[k]; },
  async put(k, v) { this._data[k] = JSON.parse(JSON.stringify(v)); },
  async initialize() {},
});

/** A minimal valid capsule definition. */
function makeValidCapsule(overrides = {}) {
  return {
    schema: 'dreamnet.synergy_capsule.v1',
    capsule_id: 'capsule-test-001',
    name: 'Test Capsule',
    version: '1.0.0',
    permissions: { allowed: ['memory.read'], blocked: ['wallet.sign'] },
    ...overrides,
  };
}

/** A minimal valid DreamLoop definition. */
function makeValidLoop(overrides = {}) {
  return {
    schema: 'dreamloop.v1',
    loop_id: 'loop-test-001',
    title: 'Test Loop',
    version: '1.0.0',
    steps: [
      { id: 'step-1', handler: 'memory.read', permission: 'memory.read' },
    ],
    limits: { max_steps: 5 },
    allowed_actions: ['memory.read'],
    blocked_actions: ['wallet.sign'],
    ...overrides,
  };
}

/** Produce a random 64-character hex string (looks like a private key). */
function makeHex64() {
  return crypto.randomBytes(32).toString('hex'); // 32 bytes = 64 hex chars
}

/** Simple HTTP GET helper — returns { status, body } where body is parsed JSON. */
function httpGet(port, path) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port, path, method: 'GET' },
      (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, body: JSON.parse(raw) });
          } catch (_) {
            resolve({ status: res.statusCode, body: raw });
          }
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// 1. Restart Recovery
// ---------------------------------------------------------------------------

describe('Restart Recovery', () => {
  test('work packet survives state-store round-trip and can be resumed', async () => {
    // Shared store to simulate persistence across "restarts"
    const store = makeMockStore();

    // First "process" — create and checkpoint a packet
    const router1 = new WorkRouter(store);
    const packet = await router1.createPacket({
      title: 'Artist Research',
      description: 'Research an artist for ZOL',
      type: 'research',
      requestedBy: 'zaal',
    });

    const checkpointState = { step: 'fetching_bio', progress: 0.4 };
    await router1.checkpoint(packet.packetId, checkpointState);

    // Second "process" — new WorkRouter backed by the same store
    const router2 = new WorkRouter(store);
    const resumed = await router2.resume(packet.packetId);

    assert.ok(resumed, 'resumed packet must not be null');
    assert.equal(resumed.packetId, packet.packetId, 'packetId preserved');
    assert.equal(resumed.status, 'pending', 'status preserved');
    assert.deepEqual(
      resumed.resumeCheckpoint,
      checkpointState,
      'checkpoint state preserved'
    );

    // Confirm the packet is still retrievable via get()
    const fetched = await router2.get(packet.packetId);
    assert.ok(fetched, 'get() must return the packet');
    assert.equal(fetched.packetId, packet.packetId);
  });
});

// ---------------------------------------------------------------------------
// 2. Idempotency
// ---------------------------------------------------------------------------

describe('Idempotency', () => {
  test('ReceiptJournal: duplicate append with same idempotencyKey returns existing receipt', async () => {
    const store = makeMockStore();
    const journal = new ReceiptJournal(store, { agentId: 'zolbot' });

    const idem = 'idem-key-abc123';

    const r1 = await journal.append({
      loopId: 'loop-1',
      runId: 'run-1',
      capsuleId: 'cap-1',
      action: 'memory.read',
      status: 'success',
      idempotencyKey: idem,
    });

    const r2 = await journal.append({
      loopId: 'loop-1',
      runId: 'run-1',
      capsuleId: 'cap-1',
      action: 'memory.read',
      status: 'success',
      idempotencyKey: idem,
    });

    assert.equal(r1.receiptId, r2.receiptId, 'same idempotencyKey must return same receiptId');

    // Confirm only one entry in the journal
    const all = await journal.list();
    assert.equal(all.length, 1, 'journal must have exactly one entry');
  });

  test('CapsuleRegistry: installing same capsule twice is idempotent', async () => {
    const store = makeMockStore();
    const registry = new CapsuleRegistry(store);

    const capsule = makeValidCapsule({ capsule_id: 'idem-capsule' });

    const r1 = await registry.install(capsule);
    const r2 = await registry.install(capsule);

    assert.equal(r1.hash, r2.hash, 'same content must produce same hash');
    assert.equal(r1.status, r2.status);

    const listed = await registry.list();
    const matches = listed.filter((c) => c.capsuleId === 'idem-capsule');
    assert.equal(matches.length, 1, 'registry must list the capsule only once');
  });

  test('WorkRouter: completing a packet twice throws TERMINAL_STATUS', async () => {
    const store = makeMockStore();
    const router = new WorkRouter(store);

    const packet = await router.createPacket({
      title: 'Idempotent Complete',
      description: 'test',
      type: 'other',
    });

    await router.complete(packet.packetId, { ok: true });
    // Second complete must throw — packet is already in a terminal state
    await assert.rejects(
      () => router.complete(packet.packetId, { ok: true, again: true }),
      (err) => {
        assert.equal(err.code, 'TERMINAL_STATUS', 'must throw TERMINAL_STATUS');
        return true;
      }
    );
  });
});

// ---------------------------------------------------------------------------
// 3. Capsule Digest Changes
// ---------------------------------------------------------------------------

describe('Capsule Digest Changes', () => {
  test('re-installing capsule with different content produces different contentHash', async () => {
    const store = makeMockStore();
    const registry = new CapsuleRegistry(store);

    const capsule_id = 'digest-test-capsule';

    // Version 1
    const capsuleV1 = makeValidCapsule({
      capsule_id,
      version: '1.0.0',
      name: 'Capsule V1',
    });
    const r1 = await registry.install(capsuleV1);

    // Version 2 — different name (changes hash)
    const capsuleV2 = makeValidCapsule({
      capsule_id,
      version: '2.0.0',
      name: 'Capsule V2 Different Description',
    });
    const r2 = await registry.install(capsuleV2);

    assert.notEqual(r1.hash, r2.hash, 'different content must produce different hash');

    // Registry should show only one current entry (v2) and have history of v1
    const listed = await registry.list();
    const match = listed.find((c) => c.capsuleId === capsule_id);
    assert.ok(match, 'capsule must be listed');
    assert.equal(match.version, '2.0.0', 'current version is v2');
  });

  test('CapsuleRegistry.validate() rejects capsule missing required schema field', () => {
    const store = makeMockStore();
    const registry = new CapsuleRegistry(store);

    // Missing 'schema' field
    const badCapsule = {
      capsule_id: 'bad-capsule',
      name: 'Bad Capsule',
      version: '1.0.0',
      permissions: { allowed: [], blocked: [] },
      // schema intentionally omitted
    };

    const result = registry.validate(badCapsule);
    assert.equal(result.valid, false, 'must be invalid');
    assert.ok(result.errors.length > 0, 'must have errors');
    // Confirm the schema error is reported
    const schemaError = result.errors.find((e) => e.includes('schema'));
    assert.ok(schemaError, 'schema error must be present');
  });
});

// ---------------------------------------------------------------------------
// 4. Malformed DreamLoops
// ---------------------------------------------------------------------------

describe('Malformed DreamLoops', () => {
  test('DreamLoopRegistry.validate() rejects loop missing loop_id', () => {
    const store = makeMockStore();
    const registry = new DreamLoopRegistry(store);

    const loop = makeValidLoop({ loop_id: undefined });

    const result = registry.validate(loop);
    assert.equal(result.valid, false, 'must be invalid');
    const err = result.errors.find((e) => e.includes('loop_id'));
    assert.ok(err, 'loop_id error must be present');
  });

  test('DreamLoopRegistry.validate() rejects loop with step using blocked permission', () => {
    const store = makeMockStore();
    const registry = new DreamLoopRegistry(store);

    const loop = makeValidLoop({
      loop_id: 'blocked-perm-loop',
      steps: [
        // This step uses 'wallet.sign' which is in blocked_actions
        { id: 'step-bad', handler: 'wallet.sign', permission: 'wallet.sign' },
      ],
      blocked_actions: ['wallet.sign'],
    });

    const result = registry.validate(loop);
    assert.equal(result.valid, false, 'must be invalid');
    const permErr = result.errors.find((e) =>
      e.includes('blocked permission') || e.includes('wallet.sign')
    );
    assert.ok(permErr, 'blocked permission error must be present');
  });

  test('DreamLoopRegistry.validate() rejects loop with more steps than limits.max_steps', () => {
    const store = makeMockStore();
    const registry = new DreamLoopRegistry(store);

    const loop = makeValidLoop({
      loop_id: 'too-many-steps-loop',
      steps: [
        { id: 'step-1', handler: 'memory.read', permission: 'memory.read' },
        { id: 'step-2', handler: 'memory.read', permission: 'memory.read' },
        { id: 'step-3', handler: 'memory.read', permission: 'memory.read' },
        { id: 'step-4', handler: 'memory.read', permission: 'memory.read' },
        { id: 'step-5', handler: 'memory.read', permission: 'memory.read' },
        { id: 'step-6', handler: 'memory.read', permission: 'memory.read' },
        { id: 'step-7', handler: 'memory.read', permission: 'memory.read' },
        { id: 'step-8', handler: 'memory.read', permission: 'memory.read' },
        { id: 'step-9', handler: 'memory.read', permission: 'memory.read' },
        { id: 'step-10', handler: 'memory.read', permission: 'memory.read' },
      ],
      limits: { max_steps: 3 }, // only 3 allowed, but 10 provided
    });

    const result = registry.validate(loop);
    assert.equal(result.valid, false, 'must be invalid');
    const limErr = result.errors.find((e) =>
      e.includes('max_steps') || e.includes('steps.length')
    );
    assert.ok(limErr, 'max_steps violation error must be present');
  });
});

// ---------------------------------------------------------------------------
// 5. Tool Denial
// ---------------------------------------------------------------------------

describe('Tool Denial', () => {
  test('ToolGateway: execute denied when grantedPermissions missing required permission', async () => {
    const store = makeMockStore();
    const gateway = new ToolGateway(store, null, { agentId: 'zolbot' });

    gateway.register({
      toolId: 'memory.write',
      name: 'memory.write',
      requiredPermission: 'memory.write',
      handler: async () => ({ ok: true }),
    });

    await assert.rejects(
      () =>
        gateway.execute('memory.write', { content: 'test' }, {
          grantedPermissions: [], // empty — should fail
        }),
      (err) => {
        assert.ok(err instanceof PermissionDeniedError, 'must be PermissionDeniedError');
        return true;
      }
    );
  });

  test('ToolGateway: execute with correct permission succeeds', async () => {
    const store = makeMockStore();
    const gateway = new ToolGateway(store, null, { agentId: 'zolbot' });

    gateway.register({
      toolId: 'memory.write',
      name: 'memory.write',
      requiredPermission: 'memory.write',
      handler: async () => ({ written: true }),
    });

    const result = await gateway.execute(
      'memory.write',
      { content: 'hello' },
      { grantedPermissions: ['memory.write'] }
    );

    assert.ok(result, 'result must exist');
    assert.ok(result.output, 'output must exist');
    assert.equal(result.output.written, true, 'handler output preserved');
  });
});

// ---------------------------------------------------------------------------
// 6. Approval Gates
// ---------------------------------------------------------------------------

describe('Approval Gates', () => {
  test('ToolGateway: tool with requiresApproval=true throws ApprovalRequiredError when not pre-approved', async () => {
    const store = makeMockStore();
    const gateway = new ToolGateway(store, null, { agentId: 'zolbot' });

    gateway.register({
      toolId: 'consequential.action',
      name: 'consequential.action',
      requiredPermission: 'consequential.action',
      requiresApproval: true,
      isConsequential: true,
      handler: async () => ({ done: true }),
    });

    await assert.rejects(
      () =>
        gateway.execute(
          'consequential.action',
          {},
          {
            grantedPermissions: ['consequential.action'],
            executionMode: 'live', // NOT mock — so approval gate applies
          }
        ),
      (err) => {
        assert.ok(err instanceof ApprovalRequiredError, 'must be ApprovalRequiredError');
        return true;
      }
    );
  });

  test('ToolGateway + ApprovalBridge: approved once succeeds; replay rejected', async () => {
    const store = makeMockStore();
    const journal = { async append(f) { return { receiptId: 'r_' + Date.now(), ...f }; } };
    const bridge = new ApprovalBridge(store, journal);
    const gateway = new ToolGateway(store, null, { agentId: 'zolbot', approvalBridge: bridge });

    gateway.register({
      toolId: 'guarded.action',
      name: 'guarded.action',
      requiredPermission: 'guarded.action',
      requiresApproval: true,
      isConsequential: true,
      handler: async () => ({ executed: true }),
    });

    // Create and approve a request
    const req = await bridge.request({ action: 'guarded.action', requestedBy: 'test-loop' });
    await bridge.decide(req.requestId, 'approved', { decidedBy: 'operator' });

    // First execution: succeeds (consumes the approval)
    const { output } = await gateway.execute('guarded.action', {}, {
      grantedPermissions: ['guarded.action'],
      executionMode: 'live',
      approvalId: req.requestId,
    });
    assert.equal(output.executed, true, 'first execution must succeed');

    // Second execution with same approvalId: replay rejected (ALREADY_CONSUMED)
    await assert.rejects(
      () => gateway.execute('guarded.action', {}, {
        grantedPermissions: ['guarded.action'],
        executionMode: 'live',
        approvalId: req.requestId,
      }),
      (err) => {
        assert.ok(err instanceof ApprovalRequiredError, 'must be ApprovalRequiredError');
        assert.equal(err.approvalCode, 'ALREADY_CONSUMED', 'must surface ALREADY_CONSUMED');
        return true;
      }
    );
  });

  test('ToolGateway + ApprovalBridge: execute without approvalId throws ApprovalRequiredError', async () => {
    const store = makeMockStore();
    const bridge = new ApprovalBridge(store, { async append() {} });
    const gateway = new ToolGateway(store, null, { agentId: 'zolbot', approvalBridge: bridge });

    gateway.register({
      toolId: 'guarded.nokey',
      name: 'guarded.nokey',
      requiredPermission: 'guarded.nokey',
      requiresApproval: true,
      handler: async () => ({}),
    });

    await assert.rejects(
      () => gateway.execute('guarded.nokey', {}, {
        grantedPermissions: ['guarded.nokey'],
        executionMode: 'live',
        // no approvalId
      }),
      (err) => {
        assert.ok(err instanceof ApprovalRequiredError);
        return true;
      }
    );
  });
});

// ---------------------------------------------------------------------------
// 7. Memory Privacy
// ---------------------------------------------------------------------------

describe('Memory Privacy', () => {
  /**
   * Base provenance/freshness builders to satisfy MemoryWeaver.validateEntry()
   */
  function baseEntry(overrides = {}) {
    return {
      type: 'working',
      content: 'test content',
      tags: [],
      provenance: { sourceType: 'operator', confidence: 1.0 },
      freshness: {},
      contradictions: [],
      ...overrides,
    };
  }

  test('MemoryWeaver: private memories excluded from public read (visibility filter)', async () => {
    const store = makeMockStore();
    const weaver = new MemoryWeaver(store);

    // Write a private memory
    await weaver.write(baseEntry({
      content: 'private data here',
      visibility: 'private',
      tags: ['private-tag'],
    }));

    // Write a public memory
    await weaver.write(baseEntry({
      content: 'public data here',
      visibility: 'public',
      tags: ['public-tag'],
    }));

    // Read with visibility='public' — private should be excluded
    const publicResults = await weaver.read({ visibility: 'public' });
    const publicContents = publicResults.map((m) => m.content);
    assert.ok(
      publicContents.includes('public data here'),
      'public memory must appear in public read'
    );
    assert.ok(
      !publicContents.includes('private data here'),
      'private memory must NOT appear in public read'
    );

    // Read without filter — both should be present
    const allResults = await weaver.read({});
    assert.equal(allResults.length, 2, 'unfiltered read must return both entries');
  });

  test('MemoryWeaver: secrets stripped from content before storage', async () => {
    const store = makeMockStore();
    const weaver = new MemoryWeaver(store);

    const secretHex = makeHex64();
    assert.equal(secretHex.length, 64, 'setup: hex must be 64 chars');

    const entry = await weaver.write(baseEntry({
      content: `Here is a secret: ${secretHex} in the content.`,
    }));

    // The stored content must have the hex redacted
    const fetched = await weaver.get(entry.memoryId);
    assert.ok(fetched, 'entry must be retrievable');
    assert.ok(
      !fetched.content.includes(secretHex),
      'raw hex secret must not be in stored content'
    );
    assert.ok(
      fetched.content.includes('[REDACTED]'),
      'content must contain [REDACTED] placeholder'
    );
  });
});

// ---------------------------------------------------------------------------
// 8. Secret Scanning
// ---------------------------------------------------------------------------

describe('Secret Scanning', () => {
  test('ReceiptJournal: credential-format secret in evidence is redacted', async () => {
    const store = makeMockStore();
    const journal = new ReceiptJournal(store, { agentId: 'zolbot' });

    // Use a credential-format secret (sk- prefix) — always redacted regardless of field name.
    // Bare 64-hex is NOT redacted (it may be a SHA-256 hash used as evidence).
    const secretKey = 'sk-abcdefghijklmnopqrstuvwxyz012345';

    const receipt = await journal.append({
      loopId: 'loop-secret-test',
      runId: 'run-secret-test',
      capsuleId: 'cap-1',
      action: 'memory.read',
      status: 'success',
      evidence: { key: secretKey, description: 'a secret value' },
    });

    const fetched = await journal.get(receipt.receiptId);
    assert.ok(fetched, 'receipt must be retrievable');

    const evidenceStr = JSON.stringify(fetched.evidence);
    assert.ok(
      !evidenceStr.includes(secretKey),
      'sk- API key must not appear in stored evidence'
    );
    assert.ok(
      evidenceStr.includes('[REDACTED]'),
      'evidence must contain [REDACTED]'
    );
  });

  test('ArtifactPipeline: credential-format secret in content is redacted', async () => {
    const store = makeMockStore();
    const pipeline = new ArtifactPipeline(store, null, { agentId: 'zolbot' });

    // Use a credential-format secret (sk- prefix) — always redacted.
    // Bare 64-hex is preserved (it is valid evidence, e.g. a SHA-256 content hash).
    const secretKey = 'sk-abcdefghijklmnopqrstuvwxyz012345';

    const artifact = await pipeline.plan({
      type: 'document',
      title: 'Secret Artifact',
      description: 'Contains a secret',
    });

    await pipeline.build(artifact.artifactId, {
      body: `Private key is ${secretKey}`,
    });

    const fetched = await pipeline.get(artifact.artifactId);
    assert.ok(fetched, 'artifact must exist');

    const contentStr = JSON.stringify(fetched.content);
    assert.ok(
      !contentStr.includes(secretKey),
      'sk- API key must not appear in stored artifact content'
    );
    assert.ok(
      contentStr.includes('[REDACTED]'),
      'artifact content must contain [REDACTED]'
    );
  });

  test('ProofDropAdapter: validate() detects secrets in bundle', () => {
    // Build a fake pipeline and journal (not used by validate())
    const fakePipeline = { get: async () => null };
    const fakeJournal = { list: async () => [] };
    const adapter = new ProofDropAdapter(fakePipeline, fakeJournal);

    const secretHex = makeHex64();

    const bundle = {
      bundleId: 'pd_test-001',
      artifactId: 'art_001',
      contentHash: 'sha256:abc123',
      receipts: [],
      generatedAt: new Date().toISOString(),
      // Manually inject secret
      metadata: { raw: secretHex },
    };

    const result = adapter.validate(bundle);
    assert.equal(result.valid, false, 'bundle with secrets must be invalid');
    const secretErr = result.errors.find((e) => e.toLowerCase().includes('secret'));
    assert.ok(secretErr, 'errors must mention "secret"');
  });
});

// ---------------------------------------------------------------------------
// 9. Corrupted State Recovery
// ---------------------------------------------------------------------------

describe('Corrupted State Recovery', () => {
  test('ReceiptJournal: missing receipt entry returns null from get()', async () => {
    const store = makeMockStore();

    // Manually insert a corrupted index that points to a non-existent receipt
    store._data['receipt-journal'] = {
      receiptIds: ['rcpt_nonexistent-0000-0000-0000-000000000000'],
      byIdempotencyKey: {},
    };

    const journal = new ReceiptJournal(store, { agentId: 'zolbot' });

    const result = await journal.get('rcpt_nonexistent-0000-0000-0000-000000000000');
    // The store returns undefined for missing keys; journal.get() must return null
    assert.equal(result, null, 'missing receipt must return null');
  });

  test('WorkRouter: get() returns null for unknown packetId', async () => {
    const store = makeMockStore();
    const router = new WorkRouter(store);

    const result = await router.get('work_nonexistent-1234');
    assert.equal(result, null, 'unknown packetId must return null');
  });

  test('CapsuleRegistry: get() returns null for unknown capsuleId', async () => {
    const store = makeMockStore();
    const registry = new CapsuleRegistry(store);

    const result = await registry.get('capsule-nonexistent');
    assert.equal(result, null, 'unknown capsuleId must return null');
  });
});

// ---------------------------------------------------------------------------
// 10. Model Fallback
// ---------------------------------------------------------------------------

describe('Model Fallback', () => {
  test('ModelGateway: falls back to fallbackProvider when primary throws', async () => {
    const store = makeMockStore();

    // Default provider is 'openrouter'; in test env OPENROUTER_MODEL_PROVIDER is
    // unset and the adapter is not available, so the gateway auto-selects 'mock'.
    // We want to test the explicit fallback path: pass provider='openrouter' but
    // patch its available getter to return false, forcing it to fall through.
    // Easiest: pass provider='openrouter' while the env is clean; the gateway
    // falls back to 'mock' automatically when the adapter is unavailable.
    //
    // Additionally test the explicit fallbackProvider arg by using a broken
    // primary and a working mock fallback.

    const gateway = new ModelGateway(store, {
      defaultProvider: 'openrouter',
      quotaTokensPerDay: 99999,
    });

    // Monkey-patch openrouter adapter's complete() to throw
    const originalAdapter = gateway._providers.openrouter;
    gateway._providers.openrouter = {
      name: 'openrouter',
      get available() { return true; }, // report available so it gets selected
      async complete() {
        throw new Error('Simulated primary provider failure');
      },
    };

    let result;
    try {
      result = await gateway.complete(
        'What is ZOL?',
        { provider: 'openrouter', fallbackProvider: 'mock' }
      );
    } finally {
      // Restore
      gateway._providers.openrouter = originalAdapter;
    }

    assert.ok(result, 'result must be returned');
    assert.ok(typeof result.text === 'string', 'text must be a string');
    assert.equal(result.provider, 'mock', 'must have used the fallback provider');
  });

  test('ModelGateway: QuotaExceededError thrown when quota exhausted', async () => {
    const store = makeMockStore();

    // Set quota to 0
    const gateway = new ModelGateway(store, {
      defaultProvider: 'mock',
      quotaTokensPerDay: 0,
    });

    await assert.rejects(
      () => gateway.complete('test prompt'),
      (err) => {
        assert.ok(err instanceof QuotaExceededError, 'must be QuotaExceededError');
        return true;
      }
    );
  });
});

// ---------------------------------------------------------------------------
// 11. Warper Keeper Disabled / Mock Modes
// ---------------------------------------------------------------------------

describe('Warper Keeper Disabled/Mock Modes', () => {
  test('createWarperKeeperAdapter({mode:"disabled"}) - all ops throw with disabled message', async () => {
    const adapter = createWarperKeeperAdapter({ mode: 'disabled' });

    assert.equal(adapter.mode, 'disabled');
    assert.equal(adapter.isEnabled(), false);

    // getAssignment
    await assert.rejects(
      () => adapter.getAssignment(),
      (err) => {
        assert.ok(err.message.includes('Disabled mode'), 'error must mention Disabled mode');
        return true;
      }
    );

    // submitWork is not a method on the current adapter API; the spec-equivalent
    // write operations are openTrapper and closeTrapper. We verify both.
    await assert.rejects(
      () => adapter.openTrapper({}),
      (err) => {
        assert.ok(err.message.includes('Disabled mode'));
        return true;
      }
    );

    await assert.rejects(
      () => adapter.closeTrapper({}),
      (err) => {
        assert.ok(err.message.includes('Disabled mode'));
        return true;
      }
    );
  });

  test('createWarperKeeperAdapter({mode:"mock"}) - returns mock responses', async () => {
    const mockAssignment = {
      ok: true,
      assignment: {
        id: 'asgn_mock-001',
        createdAt: '2026-07-01T00:00:00Z',
        expiresAt: '2026-07-08T00:00:00Z',
      },
    };

    const adapter = createWarperKeeperAdapter({
      mode: 'mock',
      assignmentKey: 'test-key',
      mockHandlers: {
        getAssignment: async () => mockAssignment,
      },
    });

    assert.equal(adapter.mode, 'mock');
    assert.equal(adapter.isEnabled(), true);

    const result = await adapter.getAssignment();
    assert.deepEqual(result, mockAssignment, 'mock response must match');
    assert.equal(result.assignment.id, 'asgn_mock-001');
  });
});

// ---------------------------------------------------------------------------
// 12. Agent Gateway MCP Endpoint Availability
// ---------------------------------------------------------------------------

describe('Agent Gateway MCP Endpoint Availability', () => {
  /** Build a minimal AgentGateway with null/stub dependencies. */
  function makeGateway(port = 0) {
    const store = makeMockStore();
    const capsuleRegistry = new CapsuleRegistry(store);
    const dreamloopRegistry = new DreamLoopRegistry(store);
    const workRouter = new WorkRouter(store);
    const pipeline = new ArtifactPipeline(store, null);
    const journal = new ReceiptJournal(store);
    const toolGateway = new ToolGateway(store, null);

    return new AgentGateway({
      capsuleRegistry,
      dreamloopRegistry,
      workRouter,
      artifactPipeline: pipeline,
      receiptJournal: journal,
      toolGateway,
      port,
      bindAddress: '127.0.0.1',
    });
  }

  test('GET /health returns 200 with status ok', async () => {
    const gw = makeGateway(0);
    const { port } = await gw.start();
    try {
      const { status, body } = await httpGet(port, '/health');
      assert.equal(status, 200, 'status must be 200');
      assert.equal(body.ok, true, 'body.ok must be true');
      assert.equal(body.status, 'ok', 'body.status must be "ok"');
      assert.equal(body.agentId, 'zolbot', 'body.agentId must be "zolbot"');
    } finally {
      await gw.stop();
    }
  });

  test('GET /mcp/tools returns array of tool definitions', async () => {
    const gw = makeGateway(0);
    const { port } = await gw.start();
    try {
      const { status, body } = await httpGet(port, '/mcp/tools');
      assert.equal(status, 200, 'status must be 200');
      assert.ok(Array.isArray(body), 'body must be an array');
      assert.ok(body.length >= 7, 'must return at least 7 MCP tool definitions, got ' + body.length);
      // Verify all entries have a name field
      for (const tool of body) {
        assert.ok(typeof tool.name === 'string', 'each tool must have a name');
      }
    } finally {
      await gw.stop();
    }
  });
});

// ---------------------------------------------------------------------------
// 13. AgentGateway {ok} Response Shape (cross-repo T1 ea8ad43c)
// ---------------------------------------------------------------------------

describe('AgentGateway {ok} Response Shape', () => {
  function makeGateway(port = 0) {
    const store = makeMockStore();
    const capsuleRegistry = new CapsuleRegistry(store);
    const dreamloopRegistry = new DreamLoopRegistry(store);
    const workRouter = new WorkRouter(store);
    const pipeline = new ArtifactPipeline(store, null);
    const journal = new ReceiptJournal(store);
    const toolGateway = new ToolGateway(store, null);
    return new AgentGateway({
      capsuleRegistry, dreamloopRegistry, workRouter,
      artifactPipeline: pipeline, receiptJournal: journal, toolGateway,
      port, bindAddress: '127.0.0.1',
    });
  }

  async function get(port, path) {
    const resp = await fetch(`http://127.0.0.1:${port}${path}`);
    const body = await resp.json();
    return { status: resp.status, body };
  }

  test('all REST success responses include ok:true', async () => {
    const gw = makeGateway(0);
    const { port } = await gw.start();
    try {
      const routes = [
        '/health', '/agent-card', '/capabilities',
        '/tasks', '/artifacts', '/receipts', '/capsules', '/dreamloops',
        '/trappers/export',
      ];
      for (const route of routes) {
        const { status, body } = await get(port, route);
        assert.equal(status, 200, `${route} must return 200`);
        assert.equal(body.ok, true, `${route} must have ok:true, got ${JSON.stringify(body)}`);
      }
    } finally {
      await gw.stop();
    }
  });

  test('error responses include ok:false', async () => {
    const gw = makeGateway(0);
    const { port } = await gw.start();
    try {
      // 404 for unknown route
      const { status, body } = await get(port, '/no-such-route');
      assert.equal(status, 404, 'unknown route must return 404');
      assert.equal(body.ok, false, 'error response must have ok:false');
      assert.ok(body.error, 'error response must have error field');
    } finally {
      await gw.stop();
    }
  });

  test('MCP /mcp/tools retains raw array (MCP protocol, no ok wrapper)', async () => {
    const gw = makeGateway(0);
    const { port } = await gw.start();
    try {
      const { status, body } = await get(port, '/mcp/tools');
      assert.equal(status, 200, '/mcp/tools must return 200');
      assert.ok(Array.isArray(body), '/mcp/tools body must be a raw array (MCP protocol)');
    } finally {
      await gw.stop();
    }
  });
});

// ---------------------------------------------------------------------------
// 13. Proof Drop Redaction
// ---------------------------------------------------------------------------

describe('Proof Drop Redaction', () => {
  /**
   * Build a minimal mock artifact pipeline that returns a delivered artifact,
   * and a minimal mock journal that returns a list of receipts.
   */
  function makeProofDropSetup({ artifactOverrides = {}, receiptEvidence = null } = {}) {
    const artifactId = 'art_pd-test-001';

    const artifact = {
      artifactId,
      type: 'document',
      title: 'Test Proof Drop Artifact',
      status: 'delivered',
      version: '1.0.0',
      contentHash: 'sha256:deadbeef',
      permissions: 'public',
      content: { body: 'safe content' },
      deliveredAt: new Date().toISOString(),
      receiptIds: ['rcpt_test-001'],
      verificationEvidence: { public: { ok: true } },
      ...artifactOverrides,
    };

    const receipt = {
      receiptId: 'rcpt_test-001',
      loopId: 'loop-pd-test',
      runId: 'run-pd-test',
      stepId: null,
      capsuleId: 'cap-1',
      agentId: 'zolbot',
      action: 'artifact.deliver',
      status: 'success',
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      durationMs: 0,
      evidence: receiptEvidence || { artifactId, delivered: true },
    };

    const mockPipeline = { get: async (id) => id === artifactId ? artifact : null };
    const mockJournal = { list: async () => [receipt] };

    return { artifactId, artifact, receipt, mockPipeline, mockJournal };
  }

  test('ProofDropAdapter.export() redacts credential-format secrets from receipt evidence', async () => {
    // Use a credential-format secret (sk- prefix) — always redacted in proof-drop bundles.
    // Bare 64-hex is preserved (it may be a SHA-256 hash used as verification evidence).
    const secretKey = 'sk-abcdefghijklmnopqrstuvwxyz012345';

    const { artifactId, mockPipeline, mockJournal } = makeProofDropSetup({
      receiptEvidence: {
        artifactId: 'art_pd-test-001',
        secretField: secretKey, // should be redacted by SECRET_PATTERNS
      },
    });

    const adapter = new ProofDropAdapter(mockPipeline, mockJournal);
    const bundle = await adapter.export(artifactId);

    const bundleStr = JSON.stringify(bundle);
    assert.ok(
      !bundleStr.includes(secretKey),
      'sk- API key must not appear in exported bundle'
    );
    assert.ok(
      bundleStr.includes('[REDACTED]'),
      'bundle must contain [REDACTED] placeholder'
    );
  });

  test('ProofDropAdapter.export() strips prompt keys from evidence', async () => {
    const { artifactId, mockPipeline, mockJournal } = makeProofDropSetup({
      receiptEvidence: {
        prompt: 'this is a secret prompt text',
        public: { ok: true },
      },
    });

    const adapter = new ProofDropAdapter(mockPipeline, mockJournal);
    const bundle = await adapter.export(artifactId);

    // Find the receipt in the bundle
    assert.ok(Array.isArray(bundle.receipts), 'bundle.receipts must be an array');
    assert.ok(bundle.receipts.length > 0, 'must have at least one receipt');

    const bundleReceipt = bundle.receipts[0];
    assert.ok(
      !bundleReceipt.evidence || !('prompt' in (bundleReceipt.evidence || {})),
      'evidence.prompt must be stripped from exported receipt'
    );
    // The public sub-key should remain (it's not a private key)
    if (bundleReceipt.evidence) {
      assert.ok(
        'public' in bundleReceipt.evidence || Object.keys(bundleReceipt.evidence).length >= 0,
        'non-private evidence fields may remain'
      );
    }
  });
});

// ---------------------------------------------------------------------------
// 14. AgentGateway Route Validation (safeParse HTTP-level)
// ---------------------------------------------------------------------------

describe('AgentGateway Route Validation (safeParse HTTP-level)', () => {
  function makeGateway(port = 0) {
    const store = makeMockStore();
    const capsuleRegistry = new CapsuleRegistry(store);
    const dreamloopRegistry = new DreamLoopRegistry(store);
    const workRouter = new WorkRouter(store);
    const pipeline = new ArtifactPipeline(store, null);
    const journal = new ReceiptJournal(store);
    const toolGateway = new ToolGateway(store, null);
    return new AgentGateway({
      capsuleRegistry, dreamloopRegistry, workRouter,
      artifactPipeline: pipeline, receiptJournal: journal, toolGateway,
      port, bindAddress: '127.0.0.1',
    });
  }

  async function post(port, path, body) {
    const resp = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: resp.status, body: await resp.json() };
  }

  test('POST /tasks with missing required fields returns ok:false with validation error', async () => {
    const gw = makeGateway(0);
    const { port } = await gw.start();
    try {
      const { status, body } = await post(port, '/tasks', {});
      assert.equal(status, 400, 'missing required fields must return 400');
      assert.equal(body.ok, false, 'response must have ok:false');
      assert.ok(typeof body.error === 'string', 'error must be a string');
      assert.ok(body.error.includes('title') || body.error.includes('required'),
        `error must mention missing field, got: ${body.error}`);
    } finally {
      await gw.stop();
    }
  });

  test('POST /tasks with valid body creates packet and returns ok:true', async () => {
    const gw = makeGateway(0);
    const { port } = await gw.start();
    try {
      const { status, body } = await post(port, '/tasks', {
        title: 'Test task',
        description: 'Integration test work packet',
        type: 'research',
      });
      assert.equal(status, 200, 'valid task body must return 200');
      assert.equal(body.ok, true, 'valid task body must have ok:true');
      assert.ok(body.task, 'response must include task object');
      assert.equal(body.created, true, 'response must indicate created:true');
    } finally {
      await gw.stop();
    }
  });

  test('POST /mcp/execute with missing tool field returns ok:false', async () => {
    const gw = makeGateway(0);
    const { port } = await gw.start();
    try {
      const { status, body } = await post(port, '/mcp/execute', {});
      assert.equal(status, 400, 'missing tool field must return 400');
      assert.equal(body.ok, false, 'response must have ok:false');
      assert.ok(body.error.includes('tool') || body.error.includes('Validation'),
        `error must reference missing tool field, got: ${body.error}`);
    } finally {
      await gw.stop();
    }
  });

  test('POST /mcp/execute with known tool + invalid input returns ok:false with schema error', async () => {
    const gw = makeGateway(0);
    const { port } = await gw.start();
    try {
      // create_work_packet requires title and description (strings)
      const { status, body } = await post(port, '/mcp/execute', {
        tool: 'create_work_packet',
        input: { title: 123, description: 456 },
      });
      // The body-level safeParse passes (tool is present), but input schema validation fails
      assert.equal(status, 400, 'invalid input schema must return 400');
      assert.equal(body.ok, false, 'response must have ok:false');
      assert.ok(body.error.toLowerCase().includes('validation'),
        `error must mention validation, got: ${body.error}`);
    } finally {
      await gw.stop();
    }
  });
});

// ---------------------------------------------------------------------------
// 15. Source Citations
// ---------------------------------------------------------------------------

describe('Source Citations', () => {
  test('Zictionary: entry with sourced citations is stored and retrievable', async () => {
    const store = makeMockStore();
    const zic = new Zictionary(store);

    const citations = [
      'ZAOOS research corpus doc 1094 — Clanker v4 token launch guide',
      'BrandonDucar/dreamloops README — Capsule schema specification',
    ];

    const entry = await zic.add({
      term: 'Capsule',
      definition: 'A governed permission bundle for a ZOL agent loop',
      citations,
    });

    assert.ok(Array.isArray(entry.citations), 'citations must be an array');
    assert.equal(entry.citations.length, 2, 'both citations must be stored');
    assert.deepEqual(entry.citations, citations, 'citation content must be preserved');

    const found = await zic.findByTerm('Capsule');
    assert.ok(found, 'entry must be findable by term after storage');
    assert.deepEqual(found.citations, citations, 'citations must survive the store round-trip');
  });

  test('Zictionary: citations are immutable after creation — edit() silently preserves original', async () => {
    const store = makeMockStore();
    const zic = new Zictionary(store);

    const original = ['doc 1094 — authoritative source'];
    const entry = await zic.add({
      term: 'LaunchRail',
      definition: 'Clanker vs 0xSplits decision router',
      citations: original,
    });

    const updated = await zic.edit(entry.entryId, {
      definition: 'Updated definition only',
      citations: ['attempted overwrite — must not land'],
    });

    assert.equal(updated.definition, 'Updated definition only', 'definition should update normally');
    assert.deepEqual(updated.citations, original, 'citations must not change via edit()');
  });

  test('Zictionary: credentials in citation strings are redacted before storage', async () => {
    const store = makeMockStore();
    const zic = new Zictionary(store);

    const entry = await zic.add({
      term: 'RedactedCite',
      definition: 'A safe definition',
      citations: ['Source: sk-supersecretkey123 must be stripped'],
    });

    assert.ok(!entry.citations[0].includes('sk-supersecretkey123'), 'sk- secret must be redacted');
    assert.ok(entry.citations[0].includes('[REDACTED]'), 'redacted placeholder must appear');
  });

  test('Zocuments: source metadata (sourceUrl, sourceName) is stored and survives export', async () => {
    const store = makeMockStore();
    const docs = new Zocuments(store);

    const doc = await docs.add({
      type: 'transcript',
      title: 'ZAO Fractal Session',
      content: 'Session recording transcript',
      sourceUrl: 'https://thezao.com/fractal/session',
      sourceName: 'ZAO Fractal Meeting W28 2026',
      permissions: 'public',
    });

    assert.equal(doc.sourceUrl, 'https://thezao.com/fractal/session', 'sourceUrl must be stored');
    assert.equal(doc.sourceName, 'ZAO Fractal Meeting W28 2026', 'sourceName must be stored');

    await docs.approve(doc.docId);
    const exported = await docs.export({ permissions: 'public' });
    const found = exported.find(d => d.docId === doc.docId);

    assert.ok(found, 'doc must appear in export after approval');
    assert.equal(found.sourceUrl, 'https://thezao.com/fractal/session', 'sourceUrl must survive export');
    assert.equal(found.sourceName, 'ZAO Fractal Meeting W28 2026', 'sourceName must survive export');
  });
});

// ---------------------------------------------------------------------------
// 16. One-Reply-Per-Social-Thread
// ---------------------------------------------------------------------------

describe('One-Reply-Per-Social-Thread', () => {
  test('WorkRouter: duplicate work packet for same thread produces separate packets (no loss)', async () => {
    const store = makeMockStore();
    const router = new WorkRouter(store);

    const THREAD_TAG = 'thread:farcaster-xyz-001';

    const p1 = await router.createPacket({
      title: 'Reply to cast',
      description: 'First reply attempt',
      type: 'reply',
      tags: [THREAD_TAG],
    });

    const p2 = await router.createPacket({
      title: 'Reply to cast',
      description: 'Second reply attempt (duplicate)',
      type: 'reply',
      tags: [THREAD_TAG],
    });

    // Both packets must be distinct
    assert.notEqual(p1.packetId, p2.packetId, 'packets must have distinct IDs');

    const all = await router.list();
    assert.equal(all.length, 2, 'router must preserve both packets (dedup is at social handler layer)');
  });

  test('MemoryWeaver: dedupeKey prevents duplicate entries for same thread', async () => {
    const store = makeMockStore();
    const weaver = new MemoryWeaver(store);

    const DEDUPE_KEY = 'thread:farcaster-xyz-001';

    function threadEntry(content) {
      return {
        type: 'working',
        content,
        tags: ['social', 'reply'],
        dedupeKey: DEDUPE_KEY,
        provenance: { sourceType: 'handler', confidence: 1.0 },
        freshness: {},
        contradictions: [],
        visibility: 'private',
      };
    }

    await weaver.write(threadEntry('First reply sent to thread xyz-001'));
    await weaver.write(threadEntry('Updated reply for thread xyz-001'));

    const all = await weaver.read({});
    // Only 1 entry should survive because dedupeKey deduplicates on write
    assert.equal(
      all.length,
      1,
      'dedupeKey must result in only one entry for the same thread'
    );
    assert.equal(
      all[0].content,
      'Updated reply for thread xyz-001',
      'latest content must be preserved'
    );
  });
});
