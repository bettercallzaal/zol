// src/handlers/sparkz-launch-readiness.js
// Sparkz energy score calculator: determines launch readiness based on creator Farcaster signals.
// Read-only. No wallet, no posting, no credentials access.

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
}

const SECRET_PATTERN = /[0-9a-fA-F]{64}|sk-[a-zA-Z0-9_-]+|ghp_[a-zA-Z0-9_-]+/;

const handlers = {

  'farcaster.follower-growth-read': async function({ input, state, signal }) {
    validateInput(input, {
      required: ['creatorFid'],
      types: { creatorFid: 'number', days: 'number' },
    });
    try {
      const { creatorFid, days = 7 } = input;
      if (state?.executionMode === 'mock' || !process.env.NEYNAR_API_KEY) {
        return {
          creatorFid,
          currentFollowers: 342,
          followersDaysAgo: 298,
          growthDays: days,
          growthAbsolute: 44,
          growthRate: 0.1476,
          dataSource: 'mock',
          timestamp: new Date().toISOString(),
        };
      }
      throw new Error('Live Neynar mode not yet implemented in prototype');
    } catch (err) {
      if (signal?.aborted) throw new Error('farcaster.follower-growth-read timed out');
      throw err;
    }
  },

  'farcaster.cast-engagement-read': async function({ input, state, signal }) {
    validateInput(input, {
      required: ['creatorFid'],
      types: { creatorFid: 'number', days: 'number' },
    });
    try {
      const { creatorFid, days = 7 } = input;
      if (state?.executionMode === 'mock' || !process.env.NEYNAR_API_KEY) {
        return {
          creatorFid,
          recentCastCount: 18,
          totalEngagement: 312,
          avgEngagementPerCast: 17.33,
          engagementTrend: 'upward',
          dataSource: 'mock',
          timestamp: new Date().toISOString(),
        };
      }
      throw new Error('Live Neynar mode not yet implemented in prototype');
    } catch (err) {
      if (signal?.aborted) throw new Error('farcaster.cast-engagement-read timed out');
      throw err;
    }
  },

  'farcaster.channel-activity-read': async function({ input, state, signal }) {
    validateInput(input, { required: ['creatorFid'], types: { creatorFid: 'number' } });
    try {
      const { creatorFid } = input;
      if (state?.executionMode === 'mock' || !process.env.NEYNAR_API_KEY) {
        return {
          creatorFid,
          primaryChannels: ['zao', 'music', 'zabal-games'],
          postsInChannels7d: 24,
          repliesInChannels7d: 12,
          mentionsReceived7d: 8,
          channelActivity: 0.68,
          communityEngagement: 'medium_high',
          dataSource: 'mock',
          timestamp: new Date().toISOString(),
        };
      }
      throw new Error('Live Neynar mode not yet implemented in prototype');
    } catch (err) {
      if (signal?.aborted) throw new Error('farcaster.channel-activity-read timed out');
      throw err;
    }
  },

  'energy-score.compute': async function({ input, executionMode, signal }) {
    validateInput(input, {
      required: ['creatorFid', 'followerGrowthRate', 'engagementRate', 'channelActivityScore'],
      types: {
        creatorFid: 'number',
        followerGrowthRate: 'number',
        engagementRate: 'number',
        channelActivityScore: 'number',
        daysSinceActive: 'number',
        minFollowers: 'number',
      },
    });
    try {
      const {
        creatorFid,
        followerGrowthRate,
        engagementRate,
        channelActivityScore,
        daysSinceActive = 7,
      } = input;

      if (executionMode !== 'mock' && SECRET_PATTERN.test(JSON.stringify(input))) {
        throw new Error('[SECURITY] Refusing to process input with secret pattern');
      }

      const weights = { followerGrowth: 0.25, engagement: 0.35, consistency: 0.20, communitySize: 0.20 };
      const followerGrowthScore = Math.min(100, Math.max(0, followerGrowthRate * 500));
      const engagementScore    = Math.min(100, Math.max(0, engagementRate * 5));
      let consistencyScore = 40;
      if (daysSinceActive >= 14) consistencyScore = 100;
      else if (daysSinceActive >= 7) consistencyScore = 70;
      const communityScore = Math.min(100, Math.max(0, channelActivityScore * 100));
      const energyScore = Math.round(
        (followerGrowthScore * weights.followerGrowth) +
        (engagementScore    * weights.engagement) +
        (consistencyScore   * weights.consistency) +
        (communityScore     * weights.communitySize)
      );

      return {
        creatorFid,
        energyScore,
        componentScores: {
          followerGrowth: Math.round(followerGrowthScore),
          engagement:     Math.round(engagementScore),
          consistency:    Math.round(consistencyScore),
          communitySize:  Math.round(communityScore),
        },
        weights,
        timestamp: new Date().toISOString(),
      };
    } catch (err) {
      if (signal?.aborted) throw new Error('energy-score.compute timed out');
      throw err;
    }
  },

  'energy-score.launch-recommendation': async function({ input, signal }) {
    validateInput(input, {
      required: ['creatorFid', 'energyScore'],
      types: { creatorFid: 'number', energyScore: 'number', componentScores: 'object' },
    });
    try {
      const {
        creatorFid,
        energyScore,
        componentScores = {},
      } = input;

      const LAUNCH_THRESHOLD = 60;
      const STRONG_THRESHOLD = 75;
      let recommendation;
      let reasoning;
      const missingSignals = [];

      if (energyScore >= STRONG_THRESHOLD) {
        recommendation = 'launch_now';
        reasoning = `Energy score is ${energyScore} (strong). Consistent growth, solid engagement, active community. Ready.`;
      } else if (energyScore >= LAUNCH_THRESHOLD) {
        recommendation = 'launch_now';
        reasoning = `Energy score is ${energyScore} (meets threshold). Launch window is open.`;
      } else if (energyScore >= 40) {
        recommendation = 'keep_building';
        reasoning = `Energy score is ${energyScore}. Building momentum but not yet launch-ready.`;
        if ((componentScores.followerGrowth || 0) < 50) missingSignals.push('Boost follower growth rate (aim for 2-3% weekly)');
        if ((componentScores.engagement || 0) < 50)     missingSignals.push('Increase cast engagement (target 15+ interactions per cast)');
        if ((componentScores.consistency || 0) < 50)    missingSignals.push('Maintain consistent posting cadence (3+ posts weekly)');
        if ((componentScores.communitySize || 0) < 50)  missingSignals.push('Deepen community presence (join 2-3 channels)');
      } else {
        recommendation = 'insufficient_data';
        reasoning = `Energy score is ${energyScore}. Not enough signal yet.`;
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
        timestamp: new Date().toISOString(),
      };
    } catch (err) {
      if (signal?.aborted) throw new Error('energy-score.launch-recommendation timed out');
      throw err;
    }
  },

  'energy-score.trend-analysis': async function({ input, signal }) {
    validateInput(input, {
      required: ['creatorFid', 'energyScore'],
      types: { creatorFid: 'number', energyScore: 'number' },
    });
    try {
      const { creatorFid, energyScore, priorScores = [] } = input;
      let trend = 'steady';
      let trendDescription = 'Energy score is holding steady';

      if (priorScores.length >= 2) {
        const change = energyScore - priorScores[priorScores.length - 2];
        if (change > 5)       { trend = 'accelerating'; trendDescription = `Accelerating (+${change} pts).`; }
        else if (change < -5) { trend = 'declining';    trendDescription = `Declining (${change} pts).`; }
      }

      let velocity = 0;
      if (priorScores.length >= 3) {
        velocity = (energyScore - priorScores[0]) / priorScores.length;
      }

      return {
        creatorFid,
        currentScore: energyScore,
        trend,
        trendDescription,
        velocity: Math.round(velocity * 100) / 100,
        scoreHistory: priorScores,
        historyLength: priorScores.length,
        timestamp: new Date().toISOString(),
      };
    } catch (err) {
      if (signal?.aborted) throw new Error('energy-score.trend-analysis timed out');
      throw err;
    }
  },

  'state.energy-history-write': async function({ input, executionMode, signal }) {
    validateInput(input, {
      required: ['creatorFid', 'energyScore'],
      types: { creatorFid: 'number', energyScore: 'number' },
    });
    try {
      const { creatorFid, energyScore, recommendation, timestamp } = input;
      if (executionMode !== 'mock' && SECRET_PATTERN.test(JSON.stringify(input))) {
        throw new Error('[SECURITY] Refusing to persist state with secret pattern');
      }
      return {
        written: true,
        creatorFid,
        energyScore,
        recommendation,
        storageKey: `energy-history:${creatorFid}`,
        timestamp: timestamp || new Date().toISOString(),
      };
    } catch (err) {
      if (signal?.aborted) throw new Error('state.energy-history-write timed out');
      throw err;
    }
  },

  // Clanker v4 mechanics (doc 1094b):
  //   - Up to 7 reward recipients at deploy; percentages immutable; wallet can change.
  //   - 0xSplits: use when adjustable %, dynamic membership, or >7 recipients needed.
  'launch-rail.decision': async function({ input, signal }) {
    validateInput(input, {
      required: ['creatorFid'],
      types: {
        creatorFid: 'number',
        collaboratorCount: 'number',
      },
    });
    try {
      const {
        creatorFid,
        collaboratorCount = 1,
        splitIsFixed = true,
        recipientsMayChange = false,
        rebalanceExpected = false,
      } = input;

      const CLANKER_MAX_RECIPIENTS = 7;
      const needsDynamic = rebalanceExpected || recipientsMayChange || collaboratorCount > CLANKER_MAX_RECIPIENTS;

      let rail;
      let reasoning;
      const constraints = [];

      if (collaboratorCount > CLANKER_MAX_RECIPIENTS) {
        rail = 'zero_x_splits';
        reasoning = `${collaboratorCount} collaborators exceeds Clanker's ${CLANKER_MAX_RECIPIENTS}-recipient limit. Use 0xSplits.`;
        constraints.push(`Clanker v4: max ${CLANKER_MAX_RECIPIENTS} recipients at deploy`);
      } else if (rebalanceExpected) {
        rail = 'zero_x_splits';
        reasoning = 'Split percentages may need rebalancing. 0xSplits enables adjustable allocation; Clanker percentages are immutable at deploy.';
        constraints.push('Clanker v4: percentages immutable at deploy');
      } else if (recipientsMayChange) {
        rail = 'zero_x_splits';
        reasoning = 'New recipients may be added later (growing team or leaderboard). 0xSplits handles dynamic membership; Clanker recipient list is fixed at deploy.';
        constraints.push('Clanker v4: recipient list fixed at deploy');
      } else if (splitIsFixed && collaboratorCount <= CLANKER_MAX_RECIPIENTS) {
        rail = 'clanker_native';
        reasoning = `${collaboratorCount} collaborator(s) with fixed percentages and stable membership. Use Clanker native recipients — no Splits contract needed. Each admin can update their wallet address if it changes.`;
        constraints.push('Clanker v4: percentages immutable; wallet per-recipient can change');
      } else {
        // splitIsFixed=false with ≤7 collaborators and no other dynamic flag — default to 0xSplits for safety
        rail = 'zero_x_splits';
        reasoning = 'Split structure is not fixed. Defaulting to 0xSplits for maximum flexibility to adjust percentages post-deploy.';
        constraints.push('Clanker v4: cannot adjust percentages after deploy');
      }

      return {
        creatorFid,
        rail,
        reasoning,
        constraints,
        inputs: { collaboratorCount, splitIsFixed, recipientsMayChange, rebalanceExpected },
        clankerNativeEligible: !needsDynamic && collaboratorCount <= CLANKER_MAX_RECIPIENTS,
        timestamp: new Date().toISOString(),
        source: 'clanker-v4-mechanics-doc-1094b',
      };
    } catch (err) {
      if (signal?.aborted) throw new Error('launch-rail.decision timed out');
      throw err;
    }
  },

  'receipt.launch-recommendation-write': async function({ input, signal }) {
    validateInput(input, {
      required: ['creatorFid', 'energyScore', 'recommendation'],
      types: { creatorFid: 'number', energyScore: 'number', recommendation: 'string' },
    });
    try {
      const { creatorFid, energyScore, recommendation, reasoning, railDecision } = input;
      return {
        receiptId: `launch-rec_${creatorFid}_${Date.now()}`,
        creatorFid,
        energyScore,
        recommendation,
        reasoning: (reasoning || '').substring(0, 500),
        railDecision: railDecision || null,
        timestamp: new Date().toISOString(),
        type: 'launch_recommendation',
      };
    } catch (err) {
      if (signal?.aborted) throw new Error('receipt.launch-recommendation-write timed out');
      throw err;
    }
  },
};

module.exports = { handlers };
