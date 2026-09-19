'use strict';

// dreamloop-registry.test.js
// Run: node --test src/__tests__/dreamloop-registry.test.js

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { DreamLoopRegistry } = require('../dreamloop-registry');

const makeMockStore = () => ({
  _data: {},
  async get(k) { return this._data[k]; },
  async put(k, v) { this._data[k] = JSON.parse(JSON.stringify(v)); },
  async initialize() {},
});

const VALID_LOOP = {
  schema: 'dreamnet.dreamloop.v1',
  loop_id: 'test-loop-v1',
  title: 'Test Loop',
  version: '1.0.0',
  allowed_actions: ['state.local.read', 'receipt.local.write'],
  blocked_actions: ['wallet.sign'],
  limits: { max_wall_time_ms: 60000, max_steps: 2, max_retries_per_step: 1 },
  steps: [
    { id: 'step-1', handler: 'state.local.read', permission: 'state.local.read', with: {}, retry: { max_attempts: 1 } },
    { id: 'step-2', handler: 'receipt.local.write', permission: 'receipt.local.write', with: {}, retry: { max_attempts: 1 } },
  ],
};

describe('DreamLoopRegistry', () => {
  let tmpDir;

  before(async () => {
    tmpDir = path.join(os.tmpdir(), 'zol-test-dlreg-' + Math.random().toString(36).slice(2));
    await fs.promises.mkdir(tmpDir, { recursive: true });
  });

  after(async () => {
    if (tmpDir) {
      await fs.promises.rm(tmpDir, { recursive: true, force: true });
    }
  });

  // Test 1: loadFromDirectory() loads JSON files from loops/ dir
  test('loadFromDirectory() loads JSON files from loops/ dir', async () => {
    const registry = new DreamLoopRegistry(makeMockStore());

    const loopFile = path.join(tmpDir, 'my-loop.manifest.json');
    await fs.promises.writeFile(loopFile, JSON.stringify(VALID_LOOP), 'utf8');

    const loops = await registry.loadFromDirectory(tmpDir);

    assert.ok(Array.isArray(loops), 'loadFromDirectory() should return an array');
    assert.ok(loops.length >= 1, 'should load at least one loop');
    const found = loops.find((l) => l.loop_id === VALID_LOOP.loop_id);
    assert.ok(found, 'loaded loop should match written loop_id');
    assert.equal(found.title, VALID_LOOP.title);
  });

  // Test 2: validate() valid loop → {valid: true}
  test('validate() valid loop → {valid: true}', () => {
    const registry = new DreamLoopRegistry(makeMockStore());

    const result = registry.validate(VALID_LOOP);

    assert.equal(result.valid, true);
    assert.deepEqual(result.errors, []);
  });

  // Test 2: validate() missing steps → {valid: false}
  test('validate() missing steps → {valid: false}', () => {
    const registry = new DreamLoopRegistry(makeMockStore());
    const bad = { ...VALID_LOOP, steps: undefined };

    const result = registry.validate(bad);

    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.toLowerCase().includes('steps')), 'error should mention steps');
  });

  // Test 3: validate() steps.length > limits.max_steps → {valid: false}
  test('validate() steps.length > limits.max_steps → {valid: false}', () => {
    const registry = new DreamLoopRegistry(makeMockStore());
    const bad = {
      ...VALID_LOOP,
      limits: { ...VALID_LOOP.limits, max_steps: 1 }, // only 1 allowed, but 2 steps
    };

    const result = registry.validate(bad);

    assert.equal(result.valid, false);
    assert.ok(
      result.errors.some((e) => e.includes('max_steps')),
      `expected max_steps error, got: ${result.errors.join(', ')}`
    );
  });

  // Test 4: validate() step uses permission in blocked_actions → {valid: false}
  test('validate() step using permission in blocked_actions → {valid: false}', () => {
    const registry = new DreamLoopRegistry(makeMockStore());
    const bad = {
      ...VALID_LOOP,
      steps: [
        { id: 'step-1', handler: 'wallet.sign', permission: 'wallet.sign', with: {} },
      ],
      limits: { ...VALID_LOOP.limits, max_steps: 1 },
    };

    const result = registry.validate(bad);

    assert.equal(result.valid, false);
    assert.ok(
      result.errors.some((e) => e.includes('blocked')),
      `expected blocked permission error, got: ${result.errors.join(', ')}`
    );
  });

  // Test 5: register() stores loop and returns {loopId, version, status:'registered'}
  test('register() stores loop and returns {loopId, version, status:"registered"}', async () => {
    const registry = new DreamLoopRegistry(makeMockStore());

    const result = await registry.register(VALID_LOOP);

    assert.equal(result.loopId, VALID_LOOP.loop_id);
    assert.equal(result.version, VALID_LOOP.version);
    assert.equal(result.status, 'registered');
  });

  // Test 6: get() returns registered loop by loopId
  test('get() returns registered loop by loopId', async () => {
    const registry = new DreamLoopRegistry(makeMockStore());
    await registry.register(VALID_LOOP);

    const record = await registry.get(VALID_LOOP.loop_id);

    assert.ok(record !== null, 'get() should return a record');
    assert.equal(record.status, 'registered');
    assert.equal(record.loop.loop_id, VALID_LOOP.loop_id);
    assert.equal(record.loop.title, VALID_LOOP.title);
  });

  // Test 7: list() returns [{loopId, title, version, status, stepCount}]
  test('list() returns [{loopId, title, version, status, stepCount}]', async () => {
    const registry = new DreamLoopRegistry(makeMockStore());
    await registry.register(VALID_LOOP);

    const list = await registry.list();

    assert.ok(Array.isArray(list), 'list() should return an array');
    assert.ok(list.length >= 1, 'list should contain at least one entry');

    const found = list.find((l) => l.loopId === VALID_LOOP.loop_id);
    assert.ok(found, 'registered loop should appear in list()');
    assert.equal(found.title, VALID_LOOP.title);
    assert.equal(found.version, VALID_LOOP.version);
    assert.equal(found.status, 'registered');
    assert.equal(found.stepCount, VALID_LOOP.steps.length);
  });
});
