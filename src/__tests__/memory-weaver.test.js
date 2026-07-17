'use strict';

// memory-weaver.test.js
// Run: node --test src/__tests__/memory-weaver.test.js

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { MemoryWeaver } = require('../memory-weaver');

const makeMockStore = () => ({
  _data: {},
  async get(k) { return this._data[k]; },
  async put(k, v) { this._data[k] = JSON.parse(JSON.stringify(v)); },
  async delete(k) { delete this._data[k]; },
  async initialize() {},
});

function makeEntry(overrides = {}) {
  return {
    type: 'working',
    content: 'some content',
    tags: [],
    provenance: { sourceType: 'operator', confidence: 1.0 },
    freshness: {},
    contradictions: [],
    ...overrides,
  };
}

describe('MemoryWeaver', () => {
  test('write() stores working memory and returns memoryId', async () => {
    const weaver = new MemoryWeaver(makeMockStore());

    const entry = await weaver.write(makeEntry({ type: 'working', content: 'working mem content' }));

    assert.ok(entry.memoryId, 'memoryId should be set');
    assert.equal(entry.type, 'working');
    assert.equal(entry.content, 'working mem content');
  });

  test('write() stores episodic memory with provenance', async () => {
    const weaver = new MemoryWeaver(makeMockStore());

    const entry = await weaver.write(makeEntry({
      type: 'episodic',
      content: 'episodic event happened',
      provenance: { sourceType: 'dreamloop', loopId: 'loop-xyz', confidence: 0.9 },
    }));

    assert.equal(entry.type, 'episodic');
    assert.equal(entry.provenance.sourceType, 'dreamloop');
    assert.equal(entry.provenance.confidence, 0.9);
    assert.ok(entry.memoryId, 'memoryId should be set');
  });

  test('read() returns memories by type', async () => {
    const weaver = new MemoryWeaver(makeMockStore());

    await weaver.write(makeEntry({ type: 'working', content: 'work item' }));
    await weaver.write(makeEntry({ type: 'episodic', content: 'past event' }));

    const results = await weaver.read({ type: 'working' });

    assert.ok(results.length >= 1, 'should return at least one working memory');
    for (const mem of results) {
      assert.equal(mem.type, 'working', `unexpected type: ${mem.type}`);
    }
  });

  test('read() with includeStale:false excludes stale memories', async () => {
    const weaver = new MemoryWeaver(makeMockStore());

    await weaver.write(makeEntry({
      type: 'working',
      content: 'stale content',
      freshness: { stale: true },
    }));
    await weaver.write(makeEntry({ type: 'working', content: 'fresh content' }));

    const results = await weaver.read({ includeStale: false });

    for (const mem of results) {
      assert.equal(
        mem.freshness.stale,
        false,
        `stale memory should be excluded; got stale=true for ${mem.memoryId}`
      );
    }
  });

  test('detectContradictions() returns empty array when no conflicts', async () => {
    const weaver = new MemoryWeaver(makeMockStore());

    await weaver.write(makeEntry({
      type: 'working',
      content: 'fact A',
      dedupeKey: 'fact-key-1',
    }));

    const contradictions = await weaver.detectContradictions(makeEntry({
      type: 'working',
      content: 'fact B',
      dedupeKey: 'fact-key-2',
    }));

    assert.deepEqual(contradictions, []);
  });

  test('expire() marks old memories stale', async () => {
    const weaver = new MemoryWeaver(makeMockStore());

    await weaver.write(makeEntry({ type: 'working', content: 'item 1' }));
    await weaver.write(makeEntry({ type: 'episodic', content: 'item 2' }));

    const count = await weaver.expire({ olderThanDays: 0 });

    assert.ok(count >= 2, `expected at least 2 expired, got ${count}`);

    const remaining = await weaver.read({ includeStale: false });
    assert.equal(remaining.length, 0, 'no fresh entries should remain after expiring all');
  });

  test('consolidate() runs without error', async () => {
    const weaver = new MemoryWeaver(makeMockStore());
    await weaver.write(makeEntry({ type: 'episodic', content: 'old event', tags: ['music'] }));

    await assert.doesNotReject(() => weaver.consolidate());
  });

  test('write() same dedupeKey twice: only latest kept', async () => {
    const weaver = new MemoryWeaver(makeMockStore());
    const key = 'unique-dedupe-key';

    await weaver.write(makeEntry({ type: 'working', content: 'version 1', dedupeKey: key }));
    await weaver.write(makeEntry({ type: 'working', content: 'version 2', dedupeKey: key }));

    const results = await weaver.read({ type: 'working', includeStale: false });
    const matching = results.filter((m) => m.dedupeKey === key);

    assert.equal(matching.length, 1, 'only one entry should exist for the dedupeKey');
    assert.equal(matching[0].content, 'version 2', 'the newer content should be kept');
  });
});
