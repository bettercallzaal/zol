// src/handlers/__tests__/sparkz-launch-readiness.test.js
// Test suite for Sparkz launch readiness handlers
// Run: node --test src/handlers/__tests__/sparkz-launch-readiness.test.js

const test = require('node:test');
const assert = require('node:assert');
const handlers = require('../sparkz-launch-readiness');

// ===== FARCASTER SIGNAL READER TESTS =====
test('farcaster.follower-growth-read: returns mock follower growth data', async (t) => {
  const result = await handlers['farcaster.follower-growth-read']({
    input: { creatorFid: 12345, days: 7 },
    state: { executionMode: 'mock' }
  });

  assert.strictEqual(result.creatorFid, 12345);
  assert.strictEqual(typeof result.growthRate, 'number');
  assert.ok(result.growthRate >= 0 && result.growthRate <= 1);
  assert.strictEqual(result.dataSource, 'mock');
});

test('farcaster.follower-growth-read: throws on missing creatorFid', async (t) => {
  try {
    await handlers['farcaster.follower-growth-read']({
      input: { days: 7 },
      state: { executionMode: 'mock' }
    });
    assert.fail('should have thrown');
  } catch (err) {
    assert.ok(err.message.includes('missing required input'));
  }
});

test('farcaster.cast-engagement-read: returns mock engagement data', async (t) => {
  const result = await handlers['farcaster.cast-engagement-read']({
    input: { creatorFid: 12345, days: 7 },
    state: { executionMode: 'mock' }
  });

  assert.strictEqual(result.creatorFid, 12345);
  assert.strictEqual(typeof result.avgEngagementPerCast, 'number');
  assert.ok(result.avgEngagementPerCast > 0);
  assert.strictEqual(result.dataSource, 'mock');
});

test('farcaster.channel-activity-read: returns mock channel activity data', async (t) => {
  const result = await handlers['farcaster.channel-activity-read']({
    input: { creatorFid: 12345 },
    state: { executionMode: 'mock' }
  });

  assert.strictEqual(result.creatorFid, 12345);
  assert.ok(Array.isArray(result.primaryChannels));
  assert.strictEqual(typeof result.channelActivity, 'number');
  assert.ok(result.channelActivity >= 0 && result.channelActivity <= 1);
});

// ===== ENERGY SCORE COMPUTATION TESTS =====
test('energy-score.compute: computes energy score from weighted signals', async (t) => {
  const result = await handlers['energy-score.compute']({
    input: {
      creatorFid: 12345,
      followerGrowthRate: 0.15,
      engagementRate: 20,
      channelActivityScore: 0.7,
      daysSinceActive: 14
    },
    state: { executionMode: 'mock' },
    executionMode: 'mock'
  });

  assert.strictEqual(result.creatorFid, 12345);
  assert.strictEqual(typeof result.energyScore, 'number');
  assert.ok(result.energyScore >= 0 && result.energyScore <= 100);
  assert.ok(result.componentScores);
  assert.ok(result.weights);
});

test('energy-score.compute: scores high for strong signals', async (t) => {
  const result = await handlers['energy-score.compute']({
    input: {
      creatorFid: 12345,
      followerGrowthRate: 0.25,
      engagementRate: 30,
      channelActivityScore: 0.9,
      daysSinceActive: 21
    },
    state: { executionMode: 'mock' },
    executionMode: 'mock'
  });

  assert.ok(result.energyScore > 70);
});

test('energy-score.compute: scores low for weak signals', async (t) => {
  const result = await handlers['energy-score.compute']({
    input: {
      creatorFid: 12345,
      followerGrowthRate: 0.01,
      engagementRate: 3,
      channelActivityScore: 0.2,
      daysSinceActive: 3
    },
    state: { executionMode: 'mock' },
    executionMode: 'mock'
  });

  assert.ok(result.energyScore < 40);
});

// ===== LAUNCH RECOMMENDATION TESTS =====
test('energy-score.launch-recommendation: recommends launch_now for high score', async (t) => {
  const result = await handlers['energy-score.launch-recommendation']({
    input: {
      creatorFid: 12345,
      energyScore: 75,
      componentScores: {
        followerGrowth: 80,
        engagement: 70,
        consistency: 75,
        communitySize: 72
      }
    },
    state: { executionMode: 'mock' },
    executionMode: 'mock'
  });

  assert.strictEqual(result.recommendation, 'launch_now');
  assert.strictEqual(result.energyScore, 75);
  assert.strictEqual(result.missingSignals.length, 0);
});

test('energy-score.launch-recommendation: recommends keep_building for medium score', async (t) => {
  const result = await handlers['energy-score.launch-recommendation']({
    input: {
      creatorFid: 12345,
      energyScore: 55,
      componentScores: {
        followerGrowth: 40,
        engagement: 45,
        consistency: 60,
        communitySize: 65
      }
    },
    state: { executionMode: 'mock' },
    executionMode: 'mock'
  });

  assert.strictEqual(result.recommendation, 'keep_building');
  assert.ok(result.missingSignals.length > 0);
  assert.strictEqual(result.nextCheckDays, 7);
});

test('energy-score.launch-recommendation: recommends insufficient_data for low score', async (t) => {
  const result = await handlers['energy-score.launch-recommendation']({
    input: {
      creatorFid: 12345,
      energyScore: 25,
      componentScores: {
        followerGrowth: 20,
        engagement: 15,
        consistency: 30,
        communitySize: 25
      }
    },
    state: { executionMode: 'mock' },
    executionMode: 'mock'
  });

  assert.strictEqual(result.recommendation, 'insufficient_data');
});

// ===== TREND ANALYSIS TESTS =====
test('energy-score.trend-analysis: detects accelerating trend', async (t) => {
  const result = await handlers['energy-score.trend-analysis']({
    input: {
      creatorFid: 12345,
      energyScore: 70,
      priorScores: [50, 60, 70]
    },
    state: { executionMode: 'mock' }
  });

  assert.strictEqual(result.trend, 'accelerating');
  assert.strictEqual(result.currentScore, 70);
  assert.ok(result.velocity > 0);
});

test('energy-score.trend-analysis: detects declining trend', async (t) => {
  const result = await handlers['energy-score.trend-analysis']({
    input: {
      creatorFid: 12345,
      energyScore: 40,
      priorScores: [70, 60, 50, 40]
    },
    state: { executionMode: 'mock' }
  });

  assert.strictEqual(result.trend, 'declining');
  assert.ok(result.velocity < 0);
});

test('energy-score.trend-analysis: detects steady trend', async (t) => {
  const result = await handlers['energy-score.trend-analysis']({
    input: {
      creatorFid: 12345,
      energyScore: 65,
      priorScores: [65, 64, 65, 66]
    },
    state: { executionMode: 'mock' }
  });

  assert.strictEqual(result.trend, 'steady');
});

// ===== STATE PERSISTENCE TESTS =====
test('state.energy-history-write: writes energy history in mock mode', async (t) => {
  const result = await handlers['state.energy-history-write']({
    input: {
      creatorFid: 12345,
      energyScore: 70,
      recommendation: 'launch_now'
    },
    state: { executionMode: 'mock' },
    executionMode: 'mock'
  });

  assert.strictEqual(result.written, true);
  assert.strictEqual(result.creatorFid, 12345);
  assert.ok(result.storageKey.includes('energy-history'));
});

test('state.energy-history-write: rejects input with secret patterns', async (t) => {
  try {
    await handlers['state.energy-history-write']({
      input: {
        creatorFid: 12345,
        energyScore: 70,
        apiKey: 'sk-12345678901234567890123456789012'
      },
      state: {},
      executionMode: 'production'
    });
    assert.fail('should have thrown');
  } catch (err) {
    assert.ok(err.message.includes('[SECURITY]'));
  }
});

// ===== RECEIPT LOGGING TESTS =====
test('receipt.launch-recommendation-write: creates launch recommendation receipt', async (t) => {
  const result = await handlers['receipt.launch-recommendation-write']({
    input: {
      creatorFid: 12345,
      energyScore: 70,
      recommendation: 'launch_now',
      reasoning: 'Creator has demonstrated strong growth and engagement.'
    },
    state: { executionMode: 'mock' }
  });

  assert.ok(result.receiptId.includes('launch-rec_'));
  assert.strictEqual(result.creatorFid, 12345);
  assert.strictEqual(result.type, 'launch_recommendation');
  assert.strictEqual(result.energyScore, 70);
});
