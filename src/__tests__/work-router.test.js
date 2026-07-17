'use strict';

// work-router.test.js
// Run: node --test src/__tests__/work-router.test.js

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { WorkRouter } = require('../work-router');

const makeMockStore = () => ({
  _data: {},
  async get(k) { return this._data[k]; },
  async put(k, v) { this._data[k] = JSON.parse(JSON.stringify(v)); },
  async initialize() {},
});

describe('WorkRouter', () => {
  test('classify("research this artist") → {isWork: true}', () => {
    const router = new WorkRouter(makeMockStore());

    const result = router.classify('research this artist');

    assert.equal(result.isWork, true);
  });

  test('classify("what do you think?") → {isWork: false}', () => {
    const router = new WorkRouter(makeMockStore());

    const result = router.classify('what do you think?');

    assert.equal(result.isWork, false);
  });

  test('createPacket() creates packet with status "pending"', async () => {
    const router = new WorkRouter(makeMockStore());

    const packet = await router.createPacket({
      title: 'Test Packet',
      description: 'A test description',
      type: 'research',
      requestedBy: 'zaal',
    });

    assert.equal(packet.status, 'pending');
    assert.ok(packet.packetId, 'packetId should be set');
    assert.equal(packet.title, 'Test Packet');
    assert.equal(packet.type, 'research');
  });

  test('clarify() sets status to "clarification_needed"', async () => {
    const router = new WorkRouter(makeMockStore());
    const packet = await router.createPacket({
      title: 'Needs Clarification',
      description: 'desc',
      type: 'research',
    });

    const updated = await router.clarify(packet.packetId, ['What genre?', 'Which era?']);

    assert.equal(updated.status, 'clarification_needed');
    assert.ok(updated.clarificationsNeeded.includes('What genre?'));
    assert.ok(updated.clarificationsNeeded.includes('Which era?'));
  });

  test('provideAnswers() updates clarificationsReceived', async () => {
    const router = new WorkRouter(makeMockStore());
    const packet = await router.createPacket({
      title: 'Test',
      description: 'desc',
      type: 'research',
    });
    await router.clarify(packet.packetId, ['What genre?']);

    const updated = await router.provideAnswers(packet.packetId, { 'What genre?': 'jazz' });

    assert.equal(updated.clarificationsReceived['What genre?'], 'jazz');
    // All questions answered → status reverts to pending
    assert.equal(updated.status, 'pending');
  });

  test('route() sets assignedTo and status "in_progress"', async () => {
    const router = new WorkRouter(makeMockStore());
    const packet = await router.createPacket({
      title: 'Route Me',
      description: 'desc',
      type: 'research',
    });

    const updated = await router.route(packet.packetId, 'dreamloop:research-and-citation-v1');

    assert.equal(updated.status, 'in_progress');
    assert.equal(updated.assignedTo, 'dreamloop:research-and-citation-v1');
  });

  test('complete() sets status "completed" with evidence', async () => {
    const router = new WorkRouter(makeMockStore());
    const packet = await router.createPacket({
      title: 'Complete Me',
      description: 'desc',
      type: 'artifact',
    });

    const updated = await router.complete(packet.packetId, { output: 'the result', links: [] });

    assert.equal(updated.status, 'completed');
    assert.ok(updated.completedAt, 'completedAt should be set');
    assert.deepEqual(updated.evidence, { output: 'the result', links: [] });
  });

  test('list({status:"pending"}) returns only pending packets', async () => {
    const router = new WorkRouter(makeMockStore());

    const p1 = await router.createPacket({ title: 'Pending 1', description: 'd', type: 'research' });
    const p2 = await router.createPacket({ title: 'Will Complete', description: 'd', type: 'artifact' });
    await router.complete(p2.packetId, { output: 'done' });

    const list = await router.list({ status: 'pending' });

    assert.ok(Array.isArray(list), 'list() should return an array');
    for (const item of list) {
      assert.equal(item.status, 'pending', `unexpected status: ${item.status}`);
    }
    const ids = list.map((p) => p.packetId);
    assert.ok(ids.includes(p1.packetId), 'pending packet should appear in filtered list');
    assert.ok(!ids.includes(p2.packetId), 'completed packet should not appear in pending list');
  });
});
