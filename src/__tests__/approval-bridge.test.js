'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { ApprovalBridge } = require('../approval-bridge');

const makeMockStore = () => ({
  _data: {},
  async get(k) { return this._data[k]; },
  async put(k, v) { this._data[k] = JSON.parse(JSON.stringify(v)); },
  async initialize() {},
});

const makeMockJournal = () => ({
  async append(f) { return { receiptId: 'rcpt_test', ...f }; },
});

describe('ApprovalBridge', () => {
  test('request() creates a pending approval request', async () => {
    const bridge = new ApprovalBridge(makeMockStore(), makeMockJournal());

    const req = await bridge.request({ action: 'post.farcaster', context: { note: 'hello' }, requestedBy: 'weekly-curator' });

    assert.equal(req.status, 'pending');
    assert.equal(req.action, 'post.farcaster');
    assert.equal(req.requestedBy, 'weekly-curator');
    assert.ok(req.requestId.startsWith('apr_'));
    assert.ok(typeof req.idempotencyKey === 'string');
    assert.ok(typeof req.createdAt === 'string');
    assert.ok(typeof req.expiresAt === 'string');
    assert.equal(req.decidedAt, null);
    assert.equal(req.decidedBy, null);
    assert.equal(req.evidence, null);
  });

  test('request() with same idempotencyKey returns existing pending request (idempotency)', async () => {
    const bridge = new ApprovalBridge(makeMockStore(), makeMockJournal());
    const iKey = 'unique-idem-key-abc123';

    const first = await bridge.request({ action: 'trapper.open', idempotencyKey: iKey });
    const second = await bridge.request({ action: 'trapper.open', idempotencyKey: iKey });

    assert.equal(first.requestId, second.requestId);
    assert.equal(second.status, 'pending');

    // Only one request should exist in the store
    const pending = await bridge.getPending();
    assert.equal(pending.length, 1);
  });

  test('decide("approved") sets status to "approved" and records decidedAt', async () => {
    const bridge = new ApprovalBridge(makeMockStore(), makeMockJournal());

    const req = await bridge.request({ action: 'post.farcaster' });
    const decided = await bridge.decide(req.requestId, 'approved', { decidedBy: 'zaal' });

    assert.equal(decided.status, 'approved');
    assert.equal(decided.decidedBy, 'zaal');
    assert.ok(typeof decided.decidedAt === 'string');
    assert.notEqual(decided.decidedAt, null);
  });

  test('decide("denied") sets status to "denied"', async () => {
    const bridge = new ApprovalBridge(makeMockStore(), makeMockJournal());

    const req = await bridge.request({ action: 'post.farcaster' });
    const decided = await bridge.decide(req.requestId, 'denied', { decidedBy: 'telegram' });

    assert.equal(decided.status, 'denied');
    assert.equal(decided.decidedBy, 'telegram');
    assert.ok(typeof decided.decidedAt === 'string');
  });

  test('cancel() sets status to "cancelled"', async () => {
    const bridge = new ApprovalBridge(makeMockStore(), makeMockJournal());

    const req = await bridge.request({ action: 'trapper.open' });
    const cancelled = await bridge.cancel(req.requestId);

    assert.equal(cancelled.status, 'cancelled');
    assert.ok(typeof cancelled.decidedAt === 'string');
    assert.notEqual(cancelled.decidedAt, null);
  });

  test('getPending() returns only pending requests', async () => {
    const bridge = new ApprovalBridge(makeMockStore(), makeMockJournal());

    const r1 = await bridge.request({ action: 'post.farcaster', idempotencyKey: 'ik-1' });
    const r2 = await bridge.request({ action: 'post.farcaster', idempotencyKey: 'ik-2' });
    const r3 = await bridge.request({ action: 'post.farcaster', idempotencyKey: 'ik-3' });

    // Approve r2 and deny r3; r1 stays pending
    await bridge.decide(r2.requestId, 'approved');
    await bridge.decide(r3.requestId, 'denied');

    const pending = await bridge.getPending();

    assert.equal(pending.length, 1);
    assert.equal(pending[0].requestId, r1.requestId);
  });

  test('expirePending() marks timed-out requests as "timeout"', async () => {
    const bridge = new ApprovalBridge(makeMockStore(), makeMockJournal());

    // Create a request that expires almost immediately (1 ms timeout)
    const req = await bridge.request({ action: 'post.farcaster', timeoutMs: 1 });

    // Wait long enough for the request to expire
    await new Promise(r => setTimeout(r, 10));

    const count = await bridge.expirePending();
    assert.equal(count, 1);

    const updated = await bridge.get(req.requestId);
    assert.equal(updated.status, 'timeout');
    assert.ok(typeof updated.decidedAt === 'string');
  });
});
