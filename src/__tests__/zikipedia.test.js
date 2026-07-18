'use strict';

// zikipedia.test.js
// Run: node --test src/__tests__/zikipedia.test.js

const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');

const { Zikipedia } = require('../zikipedia');
const { Zocuments } = require('../zocuments');
const { Zictionary } = require('../zictionary');

const makeMockStore = () => ({
  _data: {},
  async get(k) { return this._data[k]; },
  async put(k, v) { this._data[k] = JSON.parse(JSON.stringify(v)); },
  async initialize() {},
});

describe('Zikipedia', () => {
  let zocuments;
  let zictionary;
  let approvedDoc;
  let approvedEntry;

  before(async () => {
    zocuments = new Zocuments(makeMockStore());
    zictionary = new Zictionary(makeMockStore());

    const doc = await zocuments.add({
      type: 'article',
      title: 'ZOL Overview',
      content: 'ZOL is the persistent agent platform.',
      permissions: 'public',
    });
    approvedDoc = await zocuments.approve(doc.docId);

    const entry = await zictionary.add({
      term: 'ZOL',
      definition: 'Zaal\'s On-chain Listener',
    });
    approvedEntry = await zictionary.approve(entry.entryId);
  });

  test('create() with valid approved source → page with status "draft"', async () => {
    const wiki = new Zikipedia(makeMockStore(), zocuments, zictionary);

    const page = await wiki.create({
      title: 'ZOL Music Scout',
      sourceDocId: approvedDoc.docId,
    });

    assert.ok(page, 'page should be returned');
    assert.equal(page.status, 'draft');
    assert.ok(page.pageId, 'pageId should be set');
  });

  test('create() with unapproved source → throws', async () => {
    const localDocs = new Zocuments(makeMockStore());
    const localZic = new Zictionary(makeMockStore());
    const wiki = new Zikipedia(makeMockStore(), localDocs, localZic);

    const draftDoc = await localDocs.add({
      type: 'article',
      title: 'Draft Source',
      content: 'Not yet approved.',
    });
    // Do NOT approve draftDoc

    await assert.rejects(
      async () => wiki.create({ title: 'Bad Page', sourceDocId: draftDoc.docId }),
      (err) => {
        assert.ok(err instanceof Error, 'should throw an Error');
        return true;
      }
    );
  });

  test('approve() sets status "approved"', async () => {
    const wiki = new Zikipedia(makeMockStore(), zocuments, zictionary);

    const page = await wiki.create({
      title: 'Approve This Page',
      sourceDocId: approvedDoc.docId,
    });
    const approved = await wiki.approve(page.pageId);

    assert.equal(approved.status, 'approved');
  });

  test('getBySlug() finds page by generated slug', async () => {
    const wiki = new Zikipedia(makeMockStore(), zocuments, zictionary);

    const page = await wiki.create({
      title: 'ZOL Music Scout',
      sourceDocId: approvedDoc.docId,
    });

    const slug = wiki.generateSlug('ZOL Music Scout');
    const found = await wiki.getBySlug(slug);

    assert.ok(found, 'should find page by slug');
    assert.equal(found.pageId, page.pageId);
  });

  test('search() finds page by title keyword', async () => {
    const wiki = new Zikipedia(makeMockStore(), zocuments, zictionary);

    await wiki.create({ title: 'ZOL Artist Spotlight', sourceDocId: approvedDoc.docId });
    await wiki.create({ title: 'Unrelated Page', sourceDocId: approvedDoc.docId });

    const results = await wiki.search('Artist');
    const titles = results.map(p => p.title);

    assert.ok(titles.includes('ZOL Artist Spotlight'), 'should find page by title keyword');
    assert.ok(!titles.includes('Unrelated Page'), 'unrelated page should not appear');
  });

  test('generateSlug("ZOL Music Scout") → "zol-music-scout"', () => {
    const wiki = new Zikipedia(makeMockStore(), zocuments, zictionary);

    const slug = wiki.generateSlug('ZOL Music Scout');

    assert.equal(slug, 'zol-music-scout');
  });

  test('list({ status: "approved" }) returns only approved pages', async () => {
    const store = makeMockStore();
    const wiki = new Zikipedia(store, zocuments, zictionary);

    const p1 = await wiki.create({ title: 'Page Alpha', sourceDocId: approvedDoc.docId });
    await wiki.create({ title: 'Page Beta', sourceDocId: approvedDoc.docId });
    await wiki.approve(p1.pageId);

    const approved = await wiki.list({ status: 'approved' });
    const ids = approved.map(p => p.pageId);

    assert.ok(ids.includes(p1.pageId), 'approved page should be in list');
    for (const p of approved) {
      assert.equal(p.status, 'approved');
    }
  });
});
