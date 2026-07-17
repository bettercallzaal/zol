'use strict';

// zictionary.test.js
// Run: node --test src/__tests__/zictionary.test.js

const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');

const { Zictionary } = require('../zictionary');

const makeMockStore = () => ({
  _data: {},
  async get(k) { return this._data[k]; },
  async put(k, v) { this._data[k] = JSON.parse(JSON.stringify(v)); },
  async initialize() {},
});

describe('Zictionary', () => {
  test('add() creates draft entry', async () => {
    const zic = new Zictionary(makeMockStore());

    const entry = await zic.add({
      term: 'ZOL',
      definition: 'Zaal\'s On-chain Listener',
    });

    assert.ok(entry, 'entry should be returned');
    assert.equal(entry.term, 'ZOL');
    assert.equal(entry.status, 'draft');
    assert.ok(entry.entryId, 'entryId should be set');
  });

  test('findByTerm() finds by exact term', async () => {
    const zic = new Zictionary(makeMockStore());

    await zic.add({ term: 'DreamLoop', definition: 'A governed agent loop' });

    const found = await zic.findByTerm('DreamLoop');
    assert.ok(found, 'should find by exact term');
    assert.equal(found.term, 'DreamLoop');
  });

  test('findByTerm() finds by alias (case-insensitive)', async () => {
    const zic = new Zictionary(makeMockStore());

    await zic.add({
      term: 'Persistent Agent',
      definition: 'An agent that maintains state across sessions',
      aliases: ['pa', 'PersAgent'],
    });

    const found = await zic.findByTerm('persagent');
    assert.ok(found, 'should find by alias case-insensitively');
    assert.equal(found.term, 'Persistent Agent');
  });

  test('approve() sets status "approved"', async () => {
    const zic = new Zictionary(makeMockStore());

    const entry = await zic.add({ term: 'Capsule', definition: 'An agent capsule' });
    const approved = await zic.approve(entry.entryId);

    assert.equal(approved.status, 'approved');
  });

  test('reject() sets status "rejected"', async () => {
    const zic = new Zictionary(makeMockStore());

    const entry = await zic.add({ term: 'BadTerm', definition: 'A bad term' });
    const rejected = await zic.reject(entry.entryId);

    assert.equal(rejected.status, 'rejected');
  });

  test('list({ status: "approved" }) returns only approved entries', async () => {
    const store = makeMockStore();
    const zic = new Zictionary(store);

    const e1 = await zic.add({ term: 'Alpha', definition: 'First' });
    const e2 = await zic.add({ term: 'Beta', definition: 'Second' });
    await zic.approve(e1.entryId);

    const approved = await zic.list({ status: 'approved' });
    const ids = approved.map(e => e.entryId);

    assert.ok(ids.includes(e1.entryId), 'approved entry should be in list');
    assert.ok(!ids.includes(e2.entryId), 'draft entry should not be in approved list');
    for (const item of approved) {
      assert.equal(item.status, 'approved');
    }
  });

  test('addRelationship() appends relationship to entry', async () => {
    const zic = new Zictionary(makeMockStore());

    const entry = await zic.add({ term: 'Loop', definition: 'A DreamLoop' });
    const updated = await zic.addRelationship(entry.entryId, {
      type: 'related',
      targetTerm: 'Capsule',
    });

    assert.ok(Array.isArray(updated.relationships), 'relationships should be an array');
    assert.ok(updated.relationships.length > 0, 'should have at least one relationship');
    assert.equal(updated.relationships[0].targetTerm, 'Capsule');
  });

  test('export() returns only approved entries', async () => {
    const store = makeMockStore();
    const zic = new Zictionary(store);

    const e1 = await zic.add({ term: 'Exported', definition: 'Should appear' });
    await zic.add({ term: 'Draft', definition: 'Should not appear' });
    await zic.approve(e1.entryId);

    const exported = await zic.export();
    const terms = exported.map(e => e.term);

    assert.ok(terms.includes('Exported'), 'approved entry should be exported');
    assert.ok(!terms.includes('Draft'), 'draft entry should not be exported');
  });
});
