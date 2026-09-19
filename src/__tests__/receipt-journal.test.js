'use strict';

// receipt-journal.test.js
// Run: node --test src/__tests__/receipt-journal.test.js

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { ReceiptJournal } = require('../receipt-journal');

const makeMockStore = () => ({
  _data: {},
  async get(k) { return this._data[k]; },
  async put(k, v) { this._data[k] = JSON.parse(JSON.stringify(v)); },
  async initialize() {},
});

const COMMON_FIELDS = {
  loopId: 'loop-1',
  runId: 'run-1',
  capsuleId: 'cap-1',
  action: 'test.action',
  status: 'success',
};

describe('ReceiptJournal', () => {
  test('append() creates receipt with sha256 field populated', async () => {
    const journal = new ReceiptJournal(makeMockStore());

    const receipt = await journal.append({ ...COMMON_FIELDS });

    assert.ok(receipt.sha256, 'sha256 should be set');
    assert.equal(typeof receipt.sha256, 'string');
    assert.ok(receipt.sha256.length > 0, 'sha256 should be non-empty');
    assert.ok(receipt.receiptId, 'receiptId should be set');
  });

  test('append() with same idempotencyKey returns existing receipt', async () => {
    const store = makeMockStore();
    const journal = new ReceiptJournal(store);
    const key = 'idempotent-key-abc';

    const first = await journal.append({ ...COMMON_FIELDS, idempotencyKey: key });
    const second = await journal.append({ ...COMMON_FIELDS, idempotencyKey: key });

    assert.equal(second.receiptId, first.receiptId, 'both calls should return the same receiptId');
    assert.equal(second.sha256, first.sha256);

    const list = await journal.list();
    const matching = list.filter((r) => r.receiptId === first.receiptId);
    assert.equal(matching.length, 1, 'only one receipt should exist for the idempotency key');
  });

  test('append() chains previousReceiptId from previous receipt', async () => {
    const journal = new ReceiptJournal(makeMockStore());

    const first = await journal.append({ ...COMMON_FIELDS, runId: 'run-a', stepId: 'step-1' });
    const second = await journal.append({ ...COMMON_FIELDS, runId: 'run-b', stepId: 'step-2' });

    assert.equal(
      second.previousReceiptId,
      first.receiptId,
      'second receipt should link to first via previousReceiptId'
    );
  });

  test('get() retrieves receipt by receiptId', async () => {
    const journal = new ReceiptJournal(makeMockStore());

    const appended = await journal.append({ ...COMMON_FIELDS });
    const retrieved = await journal.get(appended.receiptId);

    assert.ok(retrieved, 'get() should return the receipt');
    assert.equal(retrieved.receiptId, appended.receiptId);
    assert.equal(retrieved.sha256, appended.sha256);
  });

  test('getByIdempotencyKey() finds receipt', async () => {
    const journal = new ReceiptJournal(makeMockStore());
    const key = 'find-me-key-xyz';

    const appended = await journal.append({ ...COMMON_FIELDS, idempotencyKey: key });
    const found = await journal.getByIdempotencyKey(key);

    assert.ok(found, 'getByIdempotencyKey() should return the receipt');
    assert.equal(found.receiptId, appended.receiptId);
  });

  test('list() returns receipts newest first', async () => {
    const journal = new ReceiptJournal(makeMockStore());

    const r1 = await journal.append({ ...COMMON_FIELDS, runId: 'run-1', stepId: 's1' });
    const r2 = await journal.append({ ...COMMON_FIELDS, runId: 'run-2', stepId: 's2' });
    const r3 = await journal.append({ ...COMMON_FIELDS, runId: 'run-3', stepId: 's3' });

    const list = await journal.list();

    assert.ok(list.length >= 3, 'list should have at least 3 entries');
    const ids = list.map((r) => r.receiptId);
    assert.ok(ids.indexOf(r3.receiptId) < ids.indexOf(r2.receiptId), 'r3 should come before r2 (newest first)');
    assert.ok(ids.indexOf(r2.receiptId) < ids.indexOf(r1.receiptId), 'r2 should come before r1 (newest first)');
  });

  test('evidence with secret pattern is sanitized on append()', async () => {
    const journal = new ReceiptJournal(makeMockStore());

    const receipt = await journal.append({
      ...COMMON_FIELDS,
      evidence: { token: 'ghp_FAKE12345abc', note: 'test' },
    });

    assert.ok(receipt.evidence, 'evidence should be present');
    const tokenValue = receipt.evidence.token;
    assert.ok(
      !String(tokenValue).includes('ghp_'),
      `ghp_ token should be redacted; got: ${tokenValue}`
    );
    assert.ok(
      String(tokenValue).includes('[REDACTED]'),
      `expected "[REDACTED]" in evidence; got: ${tokenValue}`
    );
  });
});
