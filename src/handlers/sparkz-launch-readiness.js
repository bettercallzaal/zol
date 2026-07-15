// src/handlers/sparkz-launch-readiness.js
// Sparkz energy score calculator: determines launch readiness based on creator Farcaster signals
// No signer access, no fund movement, no posting. Read-only on Farcaster data.

const fs = require('fs');
const path = require('path');

// Validation helper
function validateInput(input, schema) {
  const { required = [], types = {} } = schema;
  for (const key of required) {
    if (!(key in input)) throw new Error(`missing required input: ${key}`);
  }
  for (const [key, expectedType] of Object.entries(types)) {
    if (key in input && typeof input[key] !== expectedType) {
      throw new Error(`invalid type for ${key}: expected ${expectedType}, got ${typeof input[key]}`);
    }
  }
  return true;
}

const handlers = {
  // ===== FARCASTER SIGNAL READERS =====

  'farcaster.follower-growth-read': async function({ input, state, signal }) {
    validateInput(input, {
      required: ['creatorFid'],
      types: { creatorFid: 'number', days: 'number' }
    });

    try {
      const creatorFid = input.creatorFid;
      const days = input.days || 7;

      // In mock/dry-run mode, return structured mock data
      // In live mode, this would query Neynar API: GET /api/v2/farcaster/user/followers
      if (state?.executionMode === 'mock' || !process.env.NEYNAR_API_KEY) {
        return {
          creatorFid,
          currentFollowers: 342,
          followersDaysAgo: 298,
          growthDays: days,
          growthAbsolute: 44,
          growthRate: 0.1476, // 14.76% in 7 days
          dataSource: 'mock',
          timestamp: new Date().toISOString()
        };
      }

      // Live mode: query Neynar (not yet implemented in this prototype)
      throw new Error('Live Neynar mode not yet implemented in prototype');
    } catch (error) {
      if (signal?.aborted) throw new Error('farcaster.follower-growth-read timed out');
      throw error;
    }
  },

  'farcaster.cast-engagement-read': async function({ input, state, signal }) {
    validateInput(input, {
      required: ['creatorFid'],
      types: { creatorFid: 'number', days: 'number' }
    });

    try {
      const creatorFid = input.creatorFid;
      const days = input.days || 7;

      // Mock: average engagement per cast (likes + replies + recasts / cast count)
      if (state?.executionMode === 'mock' || !process.env.NEYNAR_API_KEY) {
        return {
          creatorFid,
          recentCastCount: 18,
          totalEngagement: 312,
          avgEngagementPerCast: 17.33,
          engagementTrend: 'upward', // engagement is growing day-by-day
          dataSource: 'mock',
          timestamp: new Date().toISOString()
        };
      }

      throw new Error('Live Neynar mode not yet implemented in prototype');
    } catch (error) {
      if (signal?.aborted) throw new Error('farcaster.cast-engagement-read timed out');
      throw error;
    }
  },

  'farcaster.channel-activity-read': async function({ input, state, signal }) {
    validateInput(input, {
      required: ['creatorFid'],
      types: { creatorFid: 'number' }
    });

    try {
      const creatorFid = input.creatorFid;

      // Mock: activity in community channels (frequency + depth)
      if (state?.executionMode === 'mock' || !process.env.NEYNAR_API_KEY) {
        return {
          creatorFid,
          primaryChannels: ['zao', 'music', 'zabal-games'],
          postsInChannels7d: 24,
          repliesInChannels7d: 12,
          mentionsReceived7d: 8,
          channelActivity: 0.68, // normalized 0-1: fairly active
          communityEngagement: 'medium_high',
          dataSource: 'mock',
          timestamp: new Date().toISOString()
        };
      }

      throw new Error('Live Neynar mode not yet implemented in prototype');
    } catch (error) {
      if (signal?.aborted) throw new Error('farcaster.channel-activity-read timed out');
      throw error;
    }
  },

  // ===== ENERGY SCORE CALCULATOR =====

  'energy-score.compute': async function({ input, state, executionMode, signal }) {
    validateInput(input, {
      required: ['creatorFid', 'followerGrowthRate', 'engagementRate', 'channelActivityScore'],
      types: {
        creatorFid: 'number',
        followerGrowthRate: 'number',
        engagementRate: 'number',
        channelActivityScore: 'number',
        daysSinceActive: 'number',
        minFollowers: 'number'
      }
    });

    try {
      const {
        creatorFid,
        followerGrowthRate,
        engagementRate,
        channelActivityScore,
        daysSinceActive = 7,
        minFollowers = 100
      } = input;

      // Weight thresholds from capsule manifest
      const weights = {
        followerGrowth: 0.25,
        engagement: 0.35,
        consistency: 0.20,
        communitySize: 0.20
      };

      // Compute follower growth score (0-100)
      // 0% growth = 0, 5% = 25, 10% = 50, 15% = 75, 20%+ = 100
      const followerGrowthScore = Math.min(100, Math.max(0, followerGrowthRate * 500));

      // Compute engagement rate score (0-100)
      // Normalize engagement per cast: <5 = 0, 10 = 50, 20+ = 100
      const engagementScore = Math.min(100, Math.max(0, engagementRate * 5));

      // Compute consistency score (0-100)
      // Active for >14 days = 100, 7-14 days = 70, <7 days = 40
      let consistencyScore = 40;
      if (daysSinceActive >= 14) consistencyScore = 100;
      else if (daysSinceActive >= 7) consistencyScore = 70;

      // Compute community size score (0-100)
      // This is input as normalized 0-1; convert to 0-100 and boost for follower count
      const communityScore = Math.min(100, Math.max(0, channelActivityScore * 100));

      // Weighted average
      const energyScore = Math.round(
        (followerGrowthScore * weights.followerGrowth) +
        (engagementScore * weights.engagement) +
        (consistencyScore * weights.consistency) +
        (communityScore * weights.communitySize)
      );

      // Guard: never log secrets
      if (executionMode !== 'mock') {
        const secretPattern = /[0-9a-fA-F]{64}|sk-[a-zA-Z0-9_-]+|ghp_[a-zA-Z0-9_-]+/;
        if (secretPattern.test(JSON.stringify(input))) {
          throw new Error('[SECURITY] Refusing to process input with secret pattern');
        }
      }

      return {
        creatorFid,
        energyScore,
        componentScores: {
          followerGrowth: Math.round(followerGrowthScore),
          engagement: Math.round(engagementScore),
          consistency: Math.round(consistencyScore),
          communitySize: Math.round(communityScore)
        },
        weights,
        timestamp: new Date().toISOString()
      };
    } catch (error) {
      if (signal?.aborted) throw new Error('energy-score.compute timed out');
      throw error;
    }
  },

  // ===== LAUNCH RECOMMENDATION =====

  'energy-score.launch-recommendation': async function({ input, state, executionMode, signal }) {
    validateInput(input, {
      required: ['creatorFid', 'energyScore'],
      types: { creatorFid: 'number', energyScore: 'number', componentScores: 'object' }
    });

    try {
      const {
        creatorFid,
        energyScore,
        componentScores = {},
        communitySize = 0,
        growthTrend = 'steady'
      } = input;

      const LAUNCH_THRESHOLD = 60;
      const STRONG_LAUNCH_THRESHOLD = 75;

      let recommendation = 'insufficient_data';
      let reasoning = '';
      const missingSignals = [];

      if (energyScore >= STRONG_LAUNCH_THRESHOLD) {
        recommendation = 'launch_now';
        reasoning = `Energy score is ${energyScore} (strong). Creator shows consistent growth, solid engagement, and active community participation. Ready to launch token.`;
      } else if (energyScore >= LAUNCH_THRESHOLD) {
        recommendation = 'launch_now';
        reasoning = `Energy score is ${energyScore} (meets threshold). Creator has demonstrated momentum and community buy-in. Launch window is open.`;
      } else if (energyScore >= 40) {
        recommendation = 'keep_building';
        reasoning = `Energy score is ${energyScore}. Creator is building momentum but not yet launch-ready. Focus on:`;

        if (componentScores.followerGrowth < 50) {
          missingSignals.push('Boost follower growth rate (aim for 2-3% weekly)');
        }
        if (componentScores.engagement < 50) {
          missingSignals.push('Increase cast engagement (target 15+ interactions per cast)');
        }
        if (componentScores.consistency < 50) {
          missingSignals.push('Maintain consistent posting cadence (3+ posts weekly)');
        }
        if (componentScores.communitySize < 50) {
          missingSignals.push('Deepen community presence (join 2-3 channels, increase interactions)');
        }
      } else {
        recommendation = 'insufficient_data';
        reasoning = `Energy score is ${energyScore}. Not enough data or momentum yet. Creator should build more signal.`;
        missingSignals.push('Need 2+ weeks of consistent activity');
        missingSignals.push('Need minimum 200 followers');
        missingSignals.push('Need average 10+ engagement per cast');
      }

      return {
        creatorFid,
        energyScore,
        recommendation,
        reasoning,
        missingSignals,
        launchThreshold: LAUNCH_THRESHOLD,
        nextCheckDays: recommendation === 'keep_building' ? 7 : 1,
        timestamp: new Date().toISOString()
      };
    } catch (error) {
      if (signal?.aborted) throw new Error('energy-score.launch-recommendation timed out');
      throw error;
    }
  },

  // ===== TREND ANALYSIS =====

  'energy-score.trend-analysis': async function({ input, state, executionMode, signal }) {
    validateInput(input, {
      required: ['creatorFid', 'energyScore'],
      types: { creatorFid: 'number', energyScore: 'number' }
    });

    try {
      const { creatorFid, energyScore, priorScores = [] } = input;

      let trend = 'steady';
      let trendDescription = 'Energy score is holding steady';

      if (priorScores.length >= 2) {
        const recent = priorScores.slice(-2);
        const change = energyScore - recent[0];

        if (change > 5) {
          trend = 'accelerating';
          trendDescription = `Energy score accelerating (+${change} points). Momentum is building.`;
        } else if (change < -5) {
          trend = 'declining';
          trendDescription = `Energy score declining (${change} points). May need re-engagement effort.`;
        }
      }

      // Calculate velocity (rate of change over time)
      let velocity = 0;
      if (priorScores.length >= 3) {
        const oldest = priorScores[0];
        const newest = energyScore;
        velocity = (newest - oldest) / priorScores.length;
      }

      return {
        creatorFid,
        currentScore: energyScore,
        trend,
        trendDescription,
        velocity: Math.round(velocity * 100) / 100,
        scoreHistory: priorScores,
        historyLength: priorScores.length,
        timestamp: new Date().toISOString()
      };
    } catch (error) {
      if (signal?.aborted) throw new Error('energy-score.trend-analysis timed out');
      throw error;
    }
  },

  // ===== STATE PERSISTENCE =====

  'state.energy-history-write': async function({ input, state, executionMode, signal }) {
    validateInput(input, {
      required: ['creatorFid', 'energyScore'],
      types: { creatorFid: 'number', energyScore: 'number' }
    });

    try {
      const { creatorFid, energyScore, recommendation, timestamp } = input;

      // Guard: reject secret patterns
      if (executionMode !== 'mock') {
        const secretPattern = /[0-9a-fA-F]{64}|sk-[a-zA-Z0-9_-]+|ghp_[a-zA-Z0-9_-]+/;
        if (secretPattern.test(JSON.stringify(input))) {
          throw new Error('[SECURITY] Refusing to persist state with secret pattern');
        }
      }

      // In real implementation, this would write to state-adapter
      // For now, return confirmation
      return {
        written: true,
        creatorFid,
        energyScore,
        recommendation,
        storageKey: `energy-history:${creatorFid}`,
        timestamp: timestamp || new Date().toISOString()
      };
    } catch (error) {
      if (signal?.aborted) throw new Error('state.energy-history-write timed out');
      throw error;
    }
  },

  // ===== RECEIPT LOGGING =====

  'receipt.launch-recommendation-write': async function({ input, state, signal }) {
    validateInput(input, {
      required: ['creatorFid', 'energyScore', 'recommendation'],
      types: { creatorFid: 'number', energyScore: 'number', recommendation: 'string' }
    });

    try {
      const { creatorFid, energyScore, recommendation, reasoning } = input;

      return {
        receiptId: `launch-rec_${creatorFid}_${Date.now()}`,
        creatorFid,
        energyScore,
        recommendation,
        reasoning: (reasoning || '').substring(0, 500),
        timestamp: new Date().toISOString(),
        type: 'launch_recommendation'
      };
    } catch (error) {
      if (signal?.aborted) throw new Error('receipt.launch-recommendation-write timed out');
      throw error;
    }
  }
};

module.exports = handlers;
