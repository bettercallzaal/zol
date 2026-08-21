'use strict';
// Tests for community wins spotter — pure logic functions + handler

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { parseWinEpisode, detectPatterns, validateDraft, handlers } = require('../handlers/wins-spotter');

describe('parseWinEpisode', () => {
  test('scores higher for win signal words', () => {
    const winEp  = { name: 'zal-note', content: 'Shipped WaveWarZ v2 on mainnet — community launched it.', created_at: new Date().toISOString() };
    const baseEp = { name: 'update', content: 'Regular update today.', created_at: new Date().toISOString() };
    assert.ok(parseWinEpisode(winEp).score > parseWinEpisode(baseEp).score);
  });

  test('boosts score for ZAO product mentions', () => {
    const ep = { name: 'note', content: 'COC Concertz ran smoothly.', created_at: new Date().toISOString() };
    const parsed = parseWinEpisode(ep);
    assert.ok(parsed.score > 0.4, `expected score > 0.4, got ${parsed.score}`);
  });

  test('penalizes automated source names', () => {
    const bot    = { name: 'automated-bot-system', content: 'Shipped new feature.', created_at: new Date().toISOString() };
    const human  = { name: 'zaal-note',            content: 'Shipped new feature.', created_at: new Date().toISOString() };
    assert.ok(parseWinEpisode(human).score > parseWinEpisode(bot).score);
  });

  test('truncates content to 500 chars', () => {
    const long = { name: 'x', content: 'A'.repeat(600), created_at: new Date().toISOString() };
    assert.ok(parseWinEpisode(long).content.length <= 500);
  });

  test('score is always between 0 and 1', () => {
    const ep = { name: 'n', content: 'launched shipped win success breakthrough community ZAO ZABAL'.repeat(5), created_at: new Date().toISOString() };
    const parsed = parseWinEpisode(ep);
    assert.ok(parsed.score >= 0 && parsed.score <= 1.0);
  });
});

describe('detectPatterns', () => {
  test('detects builder_energy pattern', () => {
    const wins = [{ content: 'Built and launched the new feature.' }, { content: 'Shipped v2 of the app.' }];
    const { patterns } = detectPatterns(wins);
    assert.ok(patterns.some(p => p.theme === 'builder_energy'), 'builder_energy pattern expected');
  });

  test('returns empty patterns for empty wins', () => {
    const { patterns } = detectPatterns([]);
    assert.deepEqual(patterns, []);
  });

  test('detects multiple patterns and sorts by strength', () => {
    const wins = [
      { content: 'Built music tracks for the web3 community launch.' },
      { content: 'Launched onchain music collaboration.' },
    ];
    const { patterns } = detectPatterns(wins);
    assert.ok(patterns.length >= 2);
    for (let i = 1; i < patterns.length; i++) {
      assert.ok(patterns[i-1].strength >= patterns[i].strength, 'patterns must be sorted by strength desc');
    }
  });
});

describe('validateDraft', () => {
  test('valid draft passes', () => {
    const { valid } = validateDraft('The ZAO shipped something real today. Community is building.');
    assert.ok(valid);
  });

  test('empty draft fails', () => {
    const { valid, issues } = validateDraft('');
    assert.equal(valid, false);
    assert.ok(issues.some(i => i.includes('short')));
  });

  test('draft over 1000 chars fails', () => {
    const { valid, issues } = validateDraft('A'.repeat(1001));
    assert.equal(valid, false);
    assert.ok(issues.some(i => i.includes('long')));
  });
});

describe('community.wins.spot handler', () => {
  const handler = handlers['community.wins.spot'];

  test('handler is exported', () => {
    assert.equal(typeof handler, 'function');
  });

  test('returns ok and structured result with no input (uses mock episodes)', async () => {
    const result = await handler({ input: {}, state: { executionMode: 'mock' } });
    assert.equal(typeof result.ok, 'boolean');
    assert.equal(typeof result.winsFound, 'number');
    assert.ok(Array.isArray(result.wins));
    assert.ok(Array.isArray(result.patterns));
    assert.equal(typeof result.draft, 'string');
    assert.ok(result.validation);
  });

  test('returns wins from provided episodes', async () => {
    const episodes = [
      { name: 'zaal-update', content: 'Shipped WaveWarZ on mainnet.', created_at: new Date().toISOString() },
      { name: 'zol-note', content: 'COC Concertz #7 pilot ran smoothly.', created_at: new Date().toISOString() },
    ];
    const result = await handler({ input: { episodes }, state: { executionMode: 'mock' } });
    assert.ok(result.winsFound > 0);
    assert.ok(result.draft.length > 0);
  });

  test('filters low-score episodes', async () => {
    const episodes = [
      { name: 'bot-update', content: 'System automated nothing new today.', created_at: new Date().toISOString() },
    ];
    const result = await handler({ input: { episodes }, state: { executionMode: 'mock' } });
    assert.equal(result.winsFound, 0, 'low-score episode must be filtered out');
  });

  test('never throws on garbage input', async () => {
    let result;
    assert.doesNotThrow(() => { result = handler({ input: null }); });
    result = await result;
    assert.equal(typeof result, 'object');
    assert.ok(Object.hasOwn(result, 'ok'));
  });
});
