// src/adapters/__tests__/warper-keeper-adapter.test.js
// Tests for Warper Keeper adapter using Node's built-in test runner
// Run: node --test src/adapters/__tests__/warper-keeper-adapter.test.js

const test = require('node:test');
const assert = require('node:assert');
const { createWarperKeeperAdapter, hasPrivatePatterns } = require('../warper-keeper-adapter');

test('Warper Keeper Adapter - Mode validation and initialization', async (t) => {
  await t.test('Default mode is disabled', () => {
    const adapter = createWarperKeeperAdapter({});
    assert.strictEqual(adapter.mode, 'disabled');
    assert.strictEqual(adapter.isEnabled(), false);
  });

  await t.test('Rejects invalid modes', () => {
    assert.throws(() => {
      createWarperKeeperAdapter({ mode: 'invalid' });
    }, /Invalid mode/);
  });

  await t.test('Accepts all three valid modes', async () => {
    ['disabled', 'mock', 'remote'].forEach(mode => {
      let adapter;
      if (mode === 'remote') {
        adapter = createWarperKeeperAdapter({
          mode,
          baseUrl: 'http://localhost:3000',
          assignmentKey: 'test-key',
        });
      } else if (mode === 'mock') {
        adapter = createWarperKeeperAdapter({
          mode,
          assignmentKey: 'test-key',
          mockHandlers: {
            discoverCapabilities: async () => ({ contractVersion: 1 }),
          },
        });
      } else {
        adapter = createWarperKeeperAdapter({ mode });
      }
      assert.strictEqual(adapter.mode, mode);
    });
  });
});

test('Warper Keeper Adapter - Disabled mode', async (t) => {
  await t.test('Disabled mode rejects all operations', async () => {
    const adapter = createWarperKeeperAdapter({ mode: 'disabled' });

    const operations = [
      () => adapter.discoverCapabilities(),
      () => adapter.getAssignment(),
      () => adapter.openTrapper(),
      () => adapter.appendContext({}),
      () => adapter.submitArtifact({}),
      () => adapter.requestApproval({}),
      () => adapter.closeTrapper(),
      () => adapter.releaseAssignment(),
      () => adapter.verifyProof('id'),
    ];

    for (const op of operations) {
      try {
        await op();
        assert.fail('Should have thrown');
      } catch (err) {
        assert.match(err.message, /Disabled mode/);
      }
    }
  });
});

test('Warper Keeper Adapter - Mode isolation (NO fallback)', async (t) => {
  await t.test('Mock mode with missing handler throws (no fallback to disabled)', async () => {
    const adapter = createWarperKeeperAdapter({
      mode: 'mock',
      assignmentKey: 'test-key',
      mockHandlers: {
        discoverCapabilities: async () => ({ contractVersion: 1 }),
      },
    });

    try {
      await adapter.getAssignment();
      assert.fail('Should have thrown');
    } catch (err) {
      assert.match(err.message, /mock handler/);
    }
  });

  await t.test('Remote mode validates config upfront', () => {
    assert.throws(() => {
      createWarperKeeperAdapter({
        mode: 'remote',
      });
    });
  });
});

test('Warper Keeper Adapter - Privacy guard', async (t) => {
  await t.test('hasPrivatePatterns detects 64-char hex (eth private key)', () => {
    const hex64 = 'ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
    assert.strictEqual(hasPrivatePatterns(hex64), true);
  });

  await t.test('hasPrivatePatterns detects PRIVATE_KEY patterns', () => {
    assert.strictEqual(hasPrivatePatterns('{"PRIVATE_KEY": "value"}'), true);
    assert.strictEqual(hasPrivatePatterns('{"private_key": "value"}'), true);
  });

  await t.test('hasPrivatePatterns detects API keys', () => {
    assert.strictEqual(hasPrivatePatterns('sk-ant-abc123'), true);
    assert.strictEqual(hasPrivatePatterns('ghp_abc123'), true);
  });

  await t.test('hasPrivatePatterns detects signer material', () => {
    assert.strictEqual(hasPrivatePatterns('{"signer_material": "..."}'), true);
    assert.strictEqual(hasPrivatePatterns('{"signing_key": "..."}'), true);
  });

  await t.test('hasPrivatePatterns detects hidden reasoning', () => {
    assert.strictEqual(hasPrivatePatterns('{"hidden_reasoning": "..."}'), true);
  });

  await t.test('Privacy guard blocks appendContext with secret patterns', async () => {
    const adapter = createWarperKeeperAdapter({
      mode: 'mock',
      assignmentKey: 'key',
      mockHandlers: {
        appendContext: async (payload) => {
          throw new Error('Should not reach mock handler');
        },
      },
    });

    try {
      await adapter.appendContext({
        kind: 'summary',
        text: 'Analysis with private key: ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
      });
      assert.fail('Should have thrown');
    } catch (err) {
      assert.match(err.message, /PRIVACY VIOLATION/);
    }
  });

  await t.test('Privacy guard blocks submitArtifact with secret patterns', async () => {
    const adapter = createWarperKeeperAdapter({
      mode: 'mock',
      assignmentKey: 'key',
      mockHandlers: {
        submitArtifact: async () => ({ receipt: { id: '1' } }),
      },
    });

    try {
      await adapter.submitArtifact({
        uri: 'urn:artifact:1',
        mediaType: 'text/plain',
        metadata: { secret: 'sk-ant-abc123' },
      });
      assert.fail('Should have thrown');
    } catch (err) {
      assert.match(err.message, /PRIVACY VIOLATION/);
    }
  });

  await t.test('submitArtifact rejects raw content (must be URI references only)', async () => {
    const adapter = createWarperKeeperAdapter({
      mode: 'mock',
      assignmentKey: 'key',
      mockHandlers: {
        submitArtifact: async () => ({ receipt: { id: '1' } }),
      },
    });

    const testCases = [
      { content: 'Raw artifact content' },
      { body: 'Raw body data' },
      { data: { raw: 'data' } },
    ];

    for (const testPayload of testCases) {
      try {
        await adapter.submitArtifact({
          uri: 'urn:artifact:1',
          mediaType: 'text/plain',
          ...testPayload,
        });
        assert.fail('Should have thrown');
      } catch (err) {
        assert.match(err.message, /must only include URIs and metadata/);
      }
    }
  });

  await t.test('Clean payloads without private patterns are allowed', async () => {
    const adapter = createWarperKeeperAdapter({
      mode: 'mock',
      assignmentKey: 'key',
      mockHandlers: {
        appendContext: async (payload) => ({
          ok: true,
          receipt: { id: 'rcpt_123' },
        }),
        submitArtifact: async (payload) => ({
          ok: true,
          receipt: { id: 'rcpt_456' },
        }),
      },
    });

    const ctx = await adapter.appendContext({
      kind: 'summary',
      text: 'This is a clean summary without secrets',
    });
    assert.strictEqual(ctx.receipt.id, 'rcpt_123');

    const art = await adapter.submitArtifact({
      uri: 'urn:zol:artifact:123',
      mediaType: 'application/json',
    });
    assert.strictEqual(art.receipt.id, 'rcpt_456');
  });
});

test('Warper Keeper Adapter - Idempotency and correlation IDs', async (t) => {
  await t.test('Generates idempotency and correlation IDs when not provided', async () => {
    const adapter = createWarperKeeperAdapter({
      mode: 'mock',
      assignmentKey: 'key',
      mockHandlers: {
        openTrapper: async (payload, context) => {
          assert.ok(context.requestId);
          assert.ok(context.correlationId);
          assert.ok(context.idempotencyKey);
          return { ok: true, receipt: { id: '1' } };
        },
      },
    });

    await adapter.openTrapper({});
  });

  await t.test('Uses provided correlation ID and idempotency key', async () => {
    const adapter = createWarperKeeperAdapter({
      mode: 'mock',
      assignmentKey: 'key',
      mockHandlers: {
        openTrapper: async (payload, context) => {
          assert.strictEqual(context.correlationId, 'my-correlation');
          assert.strictEqual(context.idempotencyKey, 'my-idempotency');
          return { ok: true, receipt: { id: '1' } };
        },
      },
    });

    await adapter.openTrapper({}, {
      correlationId: 'my-correlation',
      idempotencyKey: 'my-idempotency',
    });
  });
});

test('Warper Keeper Adapter - Operation specific behavior', async (t) => {
  await t.test('getAssignment returns assignment metadata', async () => {
    const adapter = createWarperKeeperAdapter({
      mode: 'mock',
      assignmentKey: 'key',
      mockHandlers: {
        getAssignment: async () => ({
          ok: true,
          assignment: {
            id: 'asgn_123',
            createdAt: '2026-07-14T00:00:00Z',
            expiresAt: '2026-07-21T00:00:00Z',
          },
        }),
      },
    });

    const result = await adapter.getAssignment();
    assert.strictEqual(result.assignment.id, 'asgn_123');
    assert.strictEqual(result.assignment.createdAt, '2026-07-14T00:00:00Z');
  });

  await t.test('verifyProof reads receipt ID', async () => {
    const adapter = createWarperKeeperAdapter({
      mode: 'mock',
      assignmentKey: 'key',
      mockHandlers: {
        verifyProof: async (receiptId, context) => {
          assert.strictEqual(receiptId, 'rcpt_789');
          return {
            ok: true,
            verified: true,
            receipt: { id: receiptId },
          };
        },
      },
    });

    const result = await adapter.verifyProof('rcpt_789');
    assert.strictEqual(result.verified, true);
  });
});
