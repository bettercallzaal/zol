'use strict';

// artifact-pipeline.test.js
// Run: node --test src/__tests__/artifact-pipeline.test.js

const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');

const { ArtifactPipeline } = require('../artifact-pipeline');

const makeMockStore = () => ({
  _data: {},
  async get(k) { return this._data[k]; },
  async put(k, v) { this._data[k] = JSON.parse(JSON.stringify(v)); },
  async initialize() {},
});

const mockJournal = {
  async append(f) {
    return { receiptId: 'rcpt_test', ...f };
  },
};

describe('ArtifactPipeline', () => {
  test('plan() creates artifact with status "planned"', async () => {
    const pipeline = new ArtifactPipeline(makeMockStore(), mockJournal);

    const artifact = await pipeline.plan({
      type: 'research',
      title: 'Test Artifact',
      description: 'A test artifact',
    });

    assert.equal(artifact.status, 'planned');
    assert.ok(artifact.artifactId, 'artifactId should be set');
    assert.equal(artifact.type, 'research');
    assert.equal(artifact.title, 'Test Artifact');
  });

  test('build(id, content) sets status "built" and sets contentHash (non-empty string)', async () => {
    const pipeline = new ArtifactPipeline(makeMockStore(), mockJournal);

    const planned = await pipeline.plan({
      type: 'research',
      title: 'Build Test',
      description: 'Testing build step',
    });

    const built = await pipeline.build(planned.artifactId, { body: 'hello world' });

    assert.equal(built.status, 'built');
    assert.ok(typeof built.contentHash === 'string', 'contentHash should be a string');
    assert.ok(built.contentHash.length > 0, 'contentHash should be non-empty');
  });

  test('build() strips secrets from content (64-char hex → "[REDACTED]")', async () => {
    const pipeline = new ArtifactPipeline(makeMockStore(), mockJournal);

    const planned = await pipeline.plan({
      type: 'research',
      title: 'Secret Strip Test',
      description: 'Testing secret stripping',
    });

    const hexSecret = 'a'.repeat(64); // 64-char hex string
    const built = await pipeline.build(planned.artifactId, {
      body: 'some text',
      key: hexSecret,
    });

    assert.equal(built.status, 'built');
    const contentStr = JSON.stringify(built.content);
    assert.ok(!contentStr.includes(hexSecret), '64-char hex should be stripped');
    assert.ok(contentStr.includes('[REDACTED]'), 'content should contain [REDACTED]');
  });

  test('verify(id, { passed: true }) sets status "verified"', async () => {
    const pipeline = new ArtifactPipeline(makeMockStore(), mockJournal);

    const planned = await pipeline.plan({
      type: 'research',
      title: 'Verify Test',
      description: 'Testing verify step',
    });
    await pipeline.build(planned.artifactId, { body: 'content' });

    const verified = await pipeline.verify(planned.artifactId, { passed: true, note: 'looks good' });

    assert.equal(verified.status, 'verified');
  });

  test('package(id) sets status "packaged"', async () => {
    const pipeline = new ArtifactPipeline(makeMockStore(), mockJournal);

    const planned = await pipeline.plan({
      type: 'research',
      title: 'Package Test',
      description: 'Testing package step',
    });
    await pipeline.build(planned.artifactId, { body: 'content' });
    await pipeline.verify(planned.artifactId, { passed: true });

    const packaged = await pipeline.package(planned.artifactId);

    assert.equal(packaged.status, 'packaged');
  });

  test('deliver(id) sets status "delivered" and sets deliveredAt', async () => {
    const pipeline = new ArtifactPipeline(makeMockStore(), mockJournal);

    const planned = await pipeline.plan({
      type: 'research',
      title: 'Deliver Test',
      description: 'Testing deliver step',
    });
    await pipeline.build(planned.artifactId, { body: 'content' });
    await pipeline.verify(planned.artifactId, { passed: true });
    await pipeline.package(planned.artifactId);

    const delivered = await pipeline.deliver(planned.artifactId);

    assert.equal(delivered.status, 'delivered');
    assert.ok(delivered.deliveredAt, 'deliveredAt should be set');
    assert.ok(typeof delivered.deliveredAt === 'string', 'deliveredAt should be a string');
  });

  test('list({ status: "planned" }) returns only planned artifacts', async () => {
    const store = makeMockStore();
    const pipeline = new ArtifactPipeline(store, mockJournal);

    const a1 = await pipeline.plan({ type: 'research', title: 'Planned A', description: 'desc' });
    const a2 = await pipeline.plan({ type: 'research', title: 'Planned B', description: 'desc' });
    await pipeline.build(a2.artifactId, { body: 'built' });

    const plannedList = await pipeline.list({ status: 'planned' });

    const ids = plannedList.map(a => a.artifactId);
    assert.ok(ids.includes(a1.artifactId), 'planned artifact should be in list');
    assert.ok(!ids.includes(a2.artifactId), 'built artifact should not be in planned list');
    for (const item of plannedList) {
      assert.equal(item.status, 'planned');
    }
  });

  test('export(id) returns artifact; export with redactPrivate=true on private artifact has content redacted', async () => {
    const pipeline = new ArtifactPipeline(makeMockStore(), mockJournal);

    const planned = await pipeline.plan({
      type: 'research',
      title: 'Export Test',
      description: 'Testing export',
      permissions: 'private',
    });
    await pipeline.build(planned.artifactId, { secret: 'my private data' });

    // Without redactPrivate: returns artifact with content present
    const exported = await pipeline.export(planned.artifactId, { redactPrivate: false });
    assert.ok(exported, 'export should return artifact');
    assert.equal(exported.artifactId, planned.artifactId);

    // With redactPrivate=true (default): private content redacted
    const redacted = await pipeline.export(planned.artifactId, { redactPrivate: true });
    assert.equal(redacted.content, '[REDACTED]', 'private content should be redacted');
  });
});
