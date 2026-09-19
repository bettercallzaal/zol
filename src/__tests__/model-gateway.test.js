'use strict';

// model-gateway.test.js
// Run: node --test src/__tests__/model-gateway.test.js

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { ModelGateway, QuotaExceededError } = require('../model-gateway');

const makeMockStore = () => ({
  _data: {},
  async get(k) { return this._data[k]; },
  async put(k, v) { this._data[k] = JSON.parse(JSON.stringify(v)); },
  async initialize() {},
});

describe('ModelGateway', () => {
  test('complete() with mock provider returns {text, provider, model, tokensEstimate, durationMs}', async () => {
    const store = makeMockStore();
    const gw = new ModelGateway(store, { defaultProvider: 'mock', quotaTokensPerDay: 10000 });

    const result = await gw.complete('hello world');

    assert.ok(typeof result.text === 'string', 'text should be a string');
    assert.ok(result.text.length > 0, 'text should be non-empty');
    assert.equal(result.provider, 'mock', 'provider should be "mock"');
    assert.ok(typeof result.model === 'string', 'model should be a string');
    assert.ok(typeof result.tokensEstimate === 'number', 'tokensEstimate should be a number');
    assert.ok(result.tokensEstimate > 0, 'tokensEstimate should be positive');
    assert.ok(typeof result.durationMs === 'number', 'durationMs should be a number');
    assert.ok(result.durationMs >= 0, 'durationMs should be >= 0');
  });

  test('getQuotaStatus() returns {tokensUsedToday, quotaLimit, remaining}', async () => {
    const store = makeMockStore();
    const gw = new ModelGateway(store, { defaultProvider: 'mock', quotaTokensPerDay: 5000 });

    const status = await gw.getQuotaStatus();

    assert.ok(typeof status.tokensUsedToday === 'number', 'tokensUsedToday should be a number');
    assert.equal(status.quotaLimit, 5000, 'quotaLimit should match constructor param');
    assert.ok(typeof status.remaining === 'number', 'remaining should be a number');
    assert.ok(status.remaining >= 0, 'remaining should be >= 0');
    assert.ok('resetAt' in status, 'resetAt should be present');
  });

  test('quota exceeded: complete() throws QuotaExceededError when over limit', async () => {
    const store = makeMockStore();
    const gw = new ModelGateway(store, { defaultProvider: 'mock', quotaTokensPerDay: 1 });

    // Pre-set usage to be at or above the quota limit
    const today = new Date().toISOString().slice(0, 10);
    await store.put('model-gateway-quota', { date: today, tokensUsedToday: 1 });

    await assert.rejects(
      () => gw.complete('any prompt'),
      (err) => {
        assert.ok(err instanceof QuotaExceededError, `expected QuotaExceededError, got ${err.constructor.name}`);
        assert.equal(err.name, 'QuotaExceededError');
        return true;
      }
    );
  });

  test('getProviders() returns array with at least one entry', async () => {
    const store = makeMockStore();
    const gw = new ModelGateway(store, { defaultProvider: 'mock', quotaTokensPerDay: 10000 });

    const providers = await gw.getProviders();

    assert.ok(Array.isArray(providers), 'getProviders() should return an array');
    assert.ok(providers.length >= 1, 'should have at least one provider');
    const mock = providers.find((p) => p.name === 'mock');
    assert.ok(mock, 'mock provider should always be present');
    assert.equal(mock.available, true);
  });

  test('telemetry: calling complete() does not log prompt text', async () => {
    const store = makeMockStore();
    const gw = new ModelGateway(store, { defaultProvider: 'mock', quotaTokensPerDay: 10000 });
    const sensitivePrompt = 'my super secret prompt text that must never appear in telemetry';

    await gw.complete(sensitivePrompt);

    const telemetry = await store.get('model-gateway-telemetry');
    assert.ok(Array.isArray(telemetry) && telemetry.length > 0, 'telemetry should be stored');

    const entry = telemetry[telemetry.length - 1];
    const entryStr = JSON.stringify(entry);
    assert.ok(
      !entryStr.includes('secret prompt'),
      'telemetry entry must not contain prompt text'
    );
    // Required metadata fields must be present
    assert.ok('provider' in entry, 'telemetry entry should have provider');
    assert.ok('model' in entry, 'telemetry entry should have model');
    assert.ok('tokensEstimate' in entry, 'telemetry entry should have tokensEstimate');
    assert.ok('durationMs' in entry, 'telemetry entry should have durationMs');
    assert.ok('success' in entry, 'telemetry entry should have success');
    assert.ok('tier' in entry, 'telemetry entry should have tier field');
  });

  test('tier routing: cheap tier resolves to haiku model for openrouter', async () => {
    const store = makeMockStore();
    let capturedModel = null;
    const mockProvider = {
      name: 'cheap-test',
      available: true,
      async complete(prompt, { model } = {}) {
        capturedModel = model;
        return { text: 'ok', model: model || 'mock' };
      },
    };
    const gw = new ModelGateway(store, {
      defaultProvider: 'openrouter',
      quotaTokensPerDay: 10000,
      providers: { openrouter: mockProvider, mock: mockProvider },
    });

    await gw.complete('classify this intent', { tier: 'cheap' });

    assert.ok(capturedModel && capturedModel.includes('haiku'), `cheap tier should resolve to haiku, got: ${capturedModel}`);
  });

  test('tier routing: frontier tier resolves to opus model for openrouter', async () => {
    const store = makeMockStore();
    let capturedModel = null;
    const mockProvider = {
      name: 'frontier-test',
      available: true,
      async complete(prompt, { model } = {}) {
        capturedModel = model;
        return { text: 'ok', model: model || 'mock' };
      },
    };
    const gw = new ModelGateway(store, {
      defaultProvider: 'openrouter',
      quotaTokensPerDay: 10000,
      providers: { openrouter: mockProvider, mock: mockProvider },
    });

    await gw.complete('reason about this complex problem', { tier: 'frontier' });

    assert.ok(capturedModel && capturedModel.includes('opus'), `frontier tier should resolve to opus, got: ${capturedModel}`);
  });

  test('tier routing: explicit model overrides tier', async () => {
    const store = makeMockStore();
    let capturedModel = null;
    const mockProvider = {
      name: 'override-test',
      available: true,
      async complete(prompt, { model } = {}) {
        capturedModel = model;
        return { text: 'ok', model: model || 'mock' };
      },
    };
    const gw = new ModelGateway(store, {
      defaultProvider: 'openrouter',
      quotaTokensPerDay: 10000,
      providers: { openrouter: mockProvider, mock: mockProvider },
    });

    await gw.complete('test', { tier: 'cheap', model: 'anthropic/claude-opus-4-8' });

    assert.equal(capturedModel, 'anthropic/claude-opus-4-8', 'explicit model should override tier');
  });

  test('tier routing: tier field recorded in telemetry', async () => {
    const store = makeMockStore();
    const gw = new ModelGateway(store, { defaultProvider: 'mock', quotaTokensPerDay: 10000 });

    await gw.complete('classify this', { tier: 'cheap' });

    const telemetry = await store.get('model-gateway-telemetry');
    const entry = telemetry[telemetry.length - 1];
    assert.equal(entry.tier, 'cheap', 'tier should be recorded in telemetry');
  });
});
