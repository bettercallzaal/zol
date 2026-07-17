'use strict';

// zocuments.test.js
// Run: node --test src/__tests__/zocuments.test.js

const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');

const { Zocuments } = require('../zocuments');

const makeMockStore = () => ({
  _data: {},
  async get(k) { return this._data[k]; },
  async put(k, v) { this._data[k] = JSON.parse(JSON.stringify(v)); },
  async initialize() {},
});

describe('Zocuments', () => {
  test('add() creates draft doc with contentHash', async () => {
    const docs = new Zocuments(makeMockStore());

    const doc = await docs.add({
      type: 'note',
      title: 'My First Note',
      content: 'Hello, ZOL!',
    });

    assert.ok(doc, 'doc should be returned');
    assert.equal(doc.status, 'draft');
    assert.ok(doc.docId, 'docId should be set');
    assert.ok(typeof doc.contentHash === 'string' && doc.contentHash.length > 0, 'contentHash should be non-empty string');
  });

  test('edit() updates title and records change', async () => {
    const docs = new Zocuments(makeMockStore());

    const doc = await docs.add({
      type: 'note',
      title: 'Original Title',
      content: 'Original content',
    });

    const updated = await docs.edit(doc.docId, { title: 'Updated Title' });

    assert.equal(updated.title, 'Updated Title');
    assert.ok(
      Array.isArray(updated.changeLog) && updated.changeLog.length > 0,
      'changeLog should record the edit'
    );
  });

  test('approve() sets status "approved"', async () => {
    const docs = new Zocuments(makeMockStore());

    const doc = await docs.add({ type: 'note', title: 'Approve Me', content: 'content' });
    const approved = await docs.approve(doc.docId);

    assert.equal(approved.status, 'approved');
  });

  test('search() finds doc by content keyword', async () => {
    const docs = new Zocuments(makeMockStore());

    await docs.add({ type: 'note', title: 'Zikipedia Guide', content: 'zikipedia is the knowledge base' });
    await docs.add({ type: 'note', title: 'Unrelated Doc', content: 'nothing special here' });

    const results = await docs.search('zikipedia');
    const titles = results.map(d => d.title);

    assert.ok(titles.includes('Zikipedia Guide'), 'should find doc with matching content keyword');
    assert.ok(!titles.includes('Unrelated Doc'), 'unrelated doc should not appear');
  });

  test('list({ type: "note" }) returns only note docs', async () => {
    const store = makeMockStore();
    const docs = new Zocuments(store);

    await docs.add({ type: 'note', title: 'Note 1', content: 'a note' });
    await docs.add({ type: 'article', title: 'Article 1', content: 'an article' });

    const notes = await docs.list({ type: 'note' });

    for (const d of notes) {
      assert.equal(d.type, 'note');
    }
    const titles = notes.map(d => d.title);
    assert.ok(titles.includes('Note 1'));
    assert.ok(!titles.includes('Article 1'));
  });

  test('export({ permissions: "public" }) returns only public docs', async () => {
    const store = makeMockStore();
    const docs = new Zocuments(store);

    await docs.add({ type: 'note', title: 'Public Doc', content: 'open', permissions: 'public' });
    await docs.add({ type: 'note', title: 'Private Doc', content: 'closed', permissions: 'private' });

    const exported = await docs.export({ permissions: 'public' });
    const titles = exported.map(d => d.title);

    assert.ok(titles.includes('Public Doc'), 'public doc should be exported');
    assert.ok(!titles.includes('Private Doc'), 'private doc should not be exported');
  });

  test('import() bulk-imports docs as drafts', async () => {
    const docs = new Zocuments(makeMockStore());

    const items = [
      { type: 'note', title: 'Import A', content: 'content a' },
      { type: 'note', title: 'Import B', content: 'content b' },
    ];

    const imported = await docs.import(items);

    assert.ok(Array.isArray(imported), 'import should return an array');
    assert.equal(imported.length, 2);
    for (const d of imported) {
      assert.equal(d.status, 'draft', 'imported docs should have status draft');
      assert.ok(d.docId, 'imported doc should have docId');
    }
  });
});
