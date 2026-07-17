'use strict';

// capsule-registry.test.js
// Run: node --test src/__tests__/capsule-registry.test.js

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { CapsuleRegistry } = require('../capsule-registry');

const makeMockStore = () => ({
  _data: {},
  async get(k) { return this._data[k]; },
  async put(k, v) { this._data[k] = JSON.parse(JSON.stringify(v)); },
  async initialize() {},
});

const VALID_CAPSULE = {
  schema: 'dreamnet.synergy_capsule.v1',
  capsule_id: 'test-capsule-v1',
  name: 'Test Capsule',
  version: '1.0.0',
  payload: { components: ['test'] },
  permissions: { allowed: ['state.local.read'], blocked: ['wallet.sign'] },
};

describe('CapsuleRegistry', () => {
  // Test 1: install() returns {capsuleId, hash, status:'installed'}
  test('install() returns {capsuleId, hash, status:"installed"}', async () => {
    const store = makeMockStore();
    const registry = new CapsuleRegistry(store);

    const result = await registry.install(VALID_CAPSULE);

    assert.equal(result.capsuleId, VALID_CAPSULE.capsule_id);
    assert.equal(result.status, 'installed');
    assert.ok(typeof result.hash === 'string' && result.hash.length > 0, 'hash should be a non-empty string');
    assert.equal(result.version, VALID_CAPSULE.version);
  });

  // Test 2: install() same version twice: second call returns existing record (no error)
  test('install() same version twice returns existing record (idempotent)', async () => {
    const store = makeMockStore();
    const registry = new CapsuleRegistry(store);

    const first = await registry.install(VALID_CAPSULE);
    const second = await registry.install(VALID_CAPSULE);

    assert.equal(second.capsuleId, first.capsuleId);
    assert.equal(second.hash, first.hash);
    assert.ok(second.status, 'status should be set on idempotent return');
  });

  // Test 3: validate() valid capsule → {valid: true, errors: []}
  test('validate() valid capsule → {valid: true, errors: []}', () => {
    const registry = new CapsuleRegistry(makeMockStore());

    const result = registry.validate(VALID_CAPSULE);

    assert.equal(result.valid, true);
    assert.deepEqual(result.errors, []);
  });

  // Test 4: validate() missing capsule_id → {valid: false, errors: contains message}
  test('validate() missing capsule_id → {valid: false, errors contains message}', () => {
    const registry = new CapsuleRegistry(makeMockStore());
    const bad = { ...VALID_CAPSULE, capsule_id: '' };

    const result = registry.validate(bad);

    assert.equal(result.valid, false);
    assert.ok(result.errors.length > 0, 'errors array should be non-empty');
    const errorText = result.errors.join(' ');
    assert.ok(
      errorText.toLowerCase().includes('capsule_id'),
      `expected error mentioning capsule_id, got: ${errorText}`
    );
  });

  // Test 5: validate() missing permissions.allowed → {valid: false}
  test('validate() missing permissions.allowed → {valid: false}', () => {
    const registry = new CapsuleRegistry(makeMockStore());
    const bad = {
      ...VALID_CAPSULE,
      permissions: { blocked: ['wallet.sign'] },
    };

    const result = registry.validate(bad);

    assert.equal(result.valid, false);
  });

  // Test 6: activate() sets status to 'active'
  test('activate() sets status to "active"', async () => {
    const store = makeMockStore();
    const registry = new CapsuleRegistry(store);
    await registry.install(VALID_CAPSULE);

    const result = await registry.activate(VALID_CAPSULE.capsule_id);

    assert.equal(result.status, 'active');
    assert.equal(result.capsuleId, VALID_CAPSULE.capsule_id);

    const stored = await registry.get(VALID_CAPSULE.capsule_id);
    assert.equal(stored.status, 'active');
  });

  // Test 7: disable() sets status to 'disabled'
  test('disable() sets status to "disabled"', async () => {
    const store = makeMockStore();
    const registry = new CapsuleRegistry(store);
    await registry.install(VALID_CAPSULE);

    const result = await registry.disable(VALID_CAPSULE.capsule_id);

    assert.equal(result.status, 'disabled');

    const stored = await registry.get(VALID_CAPSULE.capsule_id);
    assert.equal(stored.status, 'disabled');
  });

  // Test 8: list() returns array containing installed capsule
  test('list() returns array containing installed capsule', async () => {
    const store = makeMockStore();
    const registry = new CapsuleRegistry(store);
    await registry.install(VALID_CAPSULE);

    const list = await registry.list();

    assert.ok(Array.isArray(list), 'list() should return an array');
    assert.ok(list.length >= 1, 'list should contain at least one entry');
    const found = list.find((c) => c.capsuleId === VALID_CAPSULE.capsule_id);
    assert.ok(found, 'installed capsule should appear in list()');
  });
});
