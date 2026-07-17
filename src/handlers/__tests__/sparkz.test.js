'use strict';
// Tests for Sparkz launch-readiness handlers via the merged allHandlers registry

const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');

// Load through the main handlers registry to prove registration
let allHandlers;
before(() => { allHandlers = require('../index'); });

describe('Sparkz launch-readiness handlers', () => {

  test('all 8 sparkz handlers are registered', () => {
    const expected = [
      'farcaster.follower-growth-read',
      'farcaster.cast-engagement-read',
      'farcaster.channel-activity-read',
      'energy-score.compute',
      'energy-score.launch-recommendation',
      'energy-score.trend-analysis',
      'state.energy-history-write',
      'receipt.launch-recommendation-write',
    ];
    for (const name of expected) {
      assert.equal(typeof allHandlers[name], 'function', `${name} must be registered`);
    }
  });

  test('farcaster.follower-growth-read returns mock growth data', async () => {
    const result = await allHandlers['farcaster.follower-growth-read']({
      input: { creatorFid: 12345, days: 7 },
      state: { executionMode: 'mock' },
    });
    assert.equal(result.creatorFid, 12345);
    assert.equal(typeof result.growthRate, 'number');
    assert.ok(result.growthRate >= 0 && result.growthRate <= 1);
    assert.equal(result.dataSource, 'mock');
  });

  test('farcaster.follower-growth-read throws on missing creatorFid', async () => {
    await assert.rejects(
      () => allHandlers['farcaster.follower-growth-read']({ input: { days: 7 }, state: { executionMode: 'mock' } }),
      /missing required input/
    );
  });

  test('farcaster.cast-engagement-read returns mock engagement data', async () => {
    const result = await allHandlers['farcaster.cast-engagement-read']({
      input: { creatorFid: 12345, days: 7 },
      state: { executionMode: 'mock' },
    });
    assert.equal(result.creatorFid, 12345);
    assert.equal(typeof result.avgEngagementPerCast, 'number');
    assert.ok(result.avgEngagementPerCast > 0);
    assert.equal(result.dataSource, 'mock');
  });

  test('farcaster.channel-activity-read returns mock channel data', async () => {
    const result = await allHandlers['farcaster.channel-activity-read']({
      input: { creatorFid: 12345 },
      state: { executionMode: 'mock' },
    });
    assert.equal(result.creatorFid, 12345);
    assert.ok(Array.isArray(result.primaryChannels));
    assert.ok(result.channelActivity >= 0 && result.channelActivity <= 1);
  });

  test('energy-score.compute returns score 0-100', async () => {
    const result = await allHandlers['energy-score.compute']({
      input: {
        creatorFid: 12345,
        followerGrowthRate: 0.15,
        engagementRate: 20,
        channelActivityScore: 0.7,
        daysSinceActive: 14,
      },
      executionMode: 'mock',
    });
    assert.equal(result.creatorFid, 12345);
    assert.ok(result.energyScore >= 0 && result.energyScore <= 100);
    assert.ok(result.componentScores);
    assert.ok(result.weights);
  });

  test('energy-score.compute scores higher for strong signals', async () => {
    const strong = await allHandlers['energy-score.compute']({
      input: { creatorFid: 1, followerGrowthRate: 0.20, engagementRate: 30, channelActivityScore: 0.9, daysSinceActive: 21 },
      executionMode: 'mock',
    });
    const weak = await allHandlers['energy-score.compute']({
      input: { creatorFid: 2, followerGrowthRate: 0.01, engagementRate: 2, channelActivityScore: 0.1, daysSinceActive: 3 },
      executionMode: 'mock',
    });
    assert.ok(strong.energyScore > weak.energyScore, `strong (${strong.energyScore}) must beat weak (${weak.energyScore})`);
  });

  test('energy-score.launch-recommendation returns launch_now for score >= 60', async () => {
    const result = await allHandlers['energy-score.launch-recommendation']({
      input: { creatorFid: 99, energyScore: 72 },
    });
    assert.equal(result.recommendation, 'launch_now');
    assert.equal(result.creatorFid, 99);
  });

  test('energy-score.launch-recommendation returns keep_building for score 40-59', async () => {
    const result = await allHandlers['energy-score.launch-recommendation']({
      input: { creatorFid: 99, energyScore: 50 },
    });
    assert.equal(result.recommendation, 'keep_building');
    assert.ok(result.missingSignals.length > 0);
  });

  test('energy-score.launch-recommendation returns insufficient_data for score < 40', async () => {
    const result = await allHandlers['energy-score.launch-recommendation']({
      input: { creatorFid: 99, energyScore: 20 },
    });
    assert.equal(result.recommendation, 'insufficient_data');
  });

  test('energy-score.trend-analysis returns steady for no history', async () => {
    const result = await allHandlers['energy-score.trend-analysis']({
      input: { creatorFid: 5, energyScore: 55 },
    });
    assert.equal(result.trend, 'steady');
    assert.equal(result.historyLength, 0);
  });

  test('energy-score.trend-analysis detects accelerating trend', async () => {
    const result = await allHandlers['energy-score.trend-analysis']({
      input: { creatorFid: 5, energyScore: 75, priorScores: [60, 65] },
    });
    assert.equal(result.trend, 'accelerating');
  });

  test('state.energy-history-write returns written:true', async () => {
    const result = await allHandlers['state.energy-history-write']({
      input: { creatorFid: 10, energyScore: 65, recommendation: 'launch_now' },
      executionMode: 'mock',
    });
    assert.equal(result.written, true);
    assert.ok(result.storageKey.includes('10'));
  });

  test('receipt.launch-recommendation-write returns structured receipt', async () => {
    const result = await allHandlers['receipt.launch-recommendation-write']({
      input: { creatorFid: 42, energyScore: 80, recommendation: 'launch_now', reasoning: 'Strong signals.' },
    });
    assert.ok(result.receiptId.startsWith('launch-rec_42'));
    assert.equal(result.recommendation, 'launch_now');
    assert.equal(result.type, 'launch_recommendation');
  });
});
