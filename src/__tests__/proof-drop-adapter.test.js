'use strict';

// proof-drop-adapter.test.js
// Run: node --test src/__tests__/proof-drop-adapter.test.js

const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');

const { ProofDropAdapter } = require('../adapters/proof-drop-adapter');

const makeMockStore = () => ({
  _data: {},
  async get(k) { return this._data[k]; },
  async put(k, v) { this._data[k] = JSON.parse(JSON.stringify(v)); },
  async initialize() {},
});

const mockArtifactPipeline = {
  async get(id) {
    if (id === 'exists') {
      return {
        artifactId: 'exists',
        title: 'Test',
        type: 'research',
        status: 'delivered',
        contentHash: 'abc',
        receiptIds: [],
        deliveredAt: new Date().toISOString(),
        verificationEvidence: { passed: true, public: { note: 'ok' } },
      };
    }
    return null;
  },
  async list() { return []; },
};

const mockReceiptJournal = {
  async list() {
    return [
      {
        receiptId: 'r1',
        loopId: 'l1',
        action: 'test',
        status: 'success',
        evidence: { public: { key: 'val' } },
      },
    ];
  },
};

describe('ProofDropAdapter', () => {
  test('export("exists") → bundle with bundleId, contentHash, receipts', async () => {
    const adapter = new ProofDropAdapter(mockArtifactPipeline, mockReceiptJournal);

    const bundle = await adapter.export('exists');

    assert.ok(bundle.bundleId, 'bundleId should be set');
    assert.ok(bundle.contentHash, 'contentHash should be set');
    assert.ok(Array.isArray(bundle.receipts), 'receipts should be an array');
    assert.equal(bundle.artifactId, 'exists');
  });

  test('export("notfound") → throws "artifact not found"', async () => {
    const adapter = new ProofDropAdapter(mockArtifactPipeline, mockReceiptJournal);

    await assert.rejects(
      async () => adapter.export('notfound'),
      (err) => {
        assert.ok(err instanceof Error);
        assert.ok(err.message.includes('artifact not found'), `expected "artifact not found", got: ${err.message}`);
        return true;
      }
    );
  });

  test('validate() on valid bundle → { valid: true }', () => {
    const adapter = new ProofDropAdapter(mockArtifactPipeline, mockReceiptJournal);

    const validBundle = {
      bundleId: 'pd_test-123',
      artifactId: 'exists',
      contentHash: 'abc123',
      receipts: [],
      generatedAt: new Date().toISOString(),
    };

    const result = adapter.validate(validBundle);

    assert.equal(result.valid, true);
    assert.deepEqual(result.errors, []);
  });

  test('validate() on bundle missing bundleId → { valid: false }', () => {
    const adapter = new ProofDropAdapter(mockArtifactPipeline, mockReceiptJournal);

    const invalidBundle = {
      artifactId: 'exists',
      contentHash: 'abc123',
      receipts: [],
      generatedAt: new Date().toISOString(),
      // bundleId is missing
    };

    const result = adapter.validate(invalidBundle);

    assert.equal(result.valid, false);
    assert.ok(result.errors.length > 0, 'errors should be non-empty');
    assert.ok(
      result.errors.some(e => e.includes('bundleId')),
      `expected error about bundleId, got: ${JSON.stringify(result.errors)}`
    );
  });
});
