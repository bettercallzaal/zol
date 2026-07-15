#!/usr/bin/env node
// scripts/sparkz-launch-readiness-dry-run.js
// Dry-run: Compute energy scores for mock creators and display launch recommendations
// Usage: node scripts/sparkz-launch-readiness-dry-run.js

const handlers = require('../src/handlers/sparkz-launch-readiness');

// Mock creator profiles with Farcaster signals
const mockCreators = [
  {
    name: 'Luna (Emerging Producer)',
    fid: 54321,
    followerCount: 287,
    followerGrowth7d: 35,
    castCount7d: 14,
    totalEngagement7d: 245,
    avgEngagementPerCast: 17.5,
    channelActivityScore: 0.72,
    daysSinceActive: 21,
    primaryChannels: ['music', 'zao', 'production']
  },
  {
    name: 'Alex (Established Artist)',
    fid: 54322,
    followerCount: 1240,
    followerGrowth7d: 180,
    castCount7d: 32,
    totalEngagement7d: 890,
    avgEngagementPerCast: 27.8,
    channelActivityScore: 0.88,
    daysSinceActive: 45,
    primaryChannels: ['music', 'zao', 'wavewarz', 'concerts']
  },
  {
    name: 'Jordan (Early Stage)',
    fid: 54323,
    followerCount: 89,
    followerGrowth7d: 5,
    castCount7d: 3,
    totalEngagement7d: 18,
    avgEngagementPerCast: 6,
    channelActivityScore: 0.25,
    daysSinceActive: 4,
    primaryChannels: ['music']
  },
  {
    name: 'Morgan (Growing Momentum)',
    fid: 54324,
    followerCount: 542,
    followerGrowth7d: 71,
    castCount7d: 22,
    totalEngagement7d: 412,
    avgEngagementPerCast: 18.7,
    channelActivityScore: 0.65,
    daysSinceActive: 28,
    primaryChannels: ['music', 'zao', 'zabal-games']
  }
];

async function computeCreatorEnergy(creator) {
  try {
    // Compute follower growth rate
    const followerGrowthRate = creator.followerGrowth7d / creator.followerCount;
    const engagementRate = creator.avgEngagementPerCast;

    // Compute energy score
    const energyResult = await handlers['energy-score.compute']({
      input: {
        creatorFid: creator.fid,
        followerGrowthRate,
        engagementRate,
        channelActivityScore: creator.channelActivityScore,
        daysSinceActive: creator.daysSinceActive,
        minFollowers: 100
      },
      state: { executionMode: 'mock' },
      executionMode: 'mock'
    });

    // Get recommendation
    const recResult = await handlers['energy-score.launch-recommendation']({
      input: {
        creatorFid: creator.fid,
        energyScore: energyResult.energyScore,
        componentScores: energyResult.componentScores,
        communitySize: creator.followerCount,
        growthTrend: 'steady'
      },
      state: { executionMode: 'mock' },
      executionMode: 'mock'
    });

    // Get trend (mock prior scores)
    const priorScores = [
      energyResult.energyScore - 8,
      energyResult.energyScore - 4,
      energyResult.energyScore
    ];
    const trendResult = await handlers['energy-score.trend-analysis']({
      input: {
        creatorFid: creator.fid,
        energyScore: energyResult.energyScore,
        priorScores
      },
      state: { executionMode: 'mock' }
    });

    return {
      creator: creator.name,
      fid: creator.fid,
      energyScore: energyResult.energyScore,
      componentScores: energyResult.componentScores,
      recommendation: recResult.recommendation,
      reasoning: recResult.reasoning,
      missingSignals: recResult.missingSignals,
      trend: trendResult.trend,
      trendDescription: trendResult.trendDescription,
      signals: {
        followerCount: creator.followerCount,
        followerGrowth7d: creator.followerGrowth7d,
        castCount7d: creator.castCount7d,
        avgEngagementPerCast: creator.avgEngagementPerCast,
        daysActive: creator.daysSinceActive,
        channels: creator.primaryChannels
      }
    };
  } catch (error) {
    return {
      creator: creator.name,
      fid: creator.fid,
      error: error.message
    };
  }
}

async function runDryRun() {
  console.log('='.repeat(80));
  console.log('Sparkz Launch Readiness Energy Score - Dry Run');
  console.log('='.repeat(80));
  console.log('');

  console.log('Energy Score Formula:');
  console.log('  - Follower Growth Rate: 25% weight');
  console.log('  - Cast Engagement Rate: 35% weight');
  console.log('  - Activity Consistency: 20% weight');
  console.log('  - Community Activity: 20% weight');
  console.log('');
  console.log('Launch Threshold: 60 (launch_now >= 60, keep_building 40-59)');
  console.log('='.repeat(80));
  console.log('');

  const results = [];
  for (const creator of mockCreators) {
    const result = await computeCreatorEnergy(creator);
    results.push(result);
  }

  // Sort by energy score descending
  results.sort((a, b) => (b.energyScore || 0) - (a.energyScore || 0));

  for (const result of results) {
    if (result.error) {
      console.log(`[ERROR] ${result.creator}: ${result.error}`);
      console.log('');
      continue;
    }

    console.log(`Creator: ${result.creator}`);
    console.log(`FID: ${result.fid}`);
    console.log('');
    console.log(`Energy Score: ${result.energyScore}/100`);
    console.log('');
    console.log('Component Scores:');
    console.log(`  - Follower Growth: ${result.componentScores.followerGrowth}/100`);
    console.log(`  - Engagement Rate: ${result.componentScores.engagement}/100`);
    console.log(`  - Consistency: ${result.componentScores.consistency}/100`);
    console.log(`  - Community Size: ${result.componentScores.communitySize}/100`);
    console.log('');
    console.log(`Recommendation: ${result.recommendation.toUpperCase().replace(/_/g, ' ')}`);
    console.log(`Trend: ${result.trend.charAt(0).toUpperCase() + result.trend.slice(1)}`);
    console.log(`${result.trendDescription}`);
    console.log('');
    console.log('Reasoning:');
    console.log(`  ${result.reasoning}`);
    console.log('');

    if (result.missingSignals.length > 0) {
      console.log('Missing Signals (if keep_building):');
      result.missingSignals.forEach(signal => {
        console.log(`  - ${signal}`);
      });
      console.log('');
    }

    console.log('Farcaster Signals:');
    console.log(`  - Followers: ${result.signals.followerCount}`);
    console.log(`  - 7-Day Follower Growth: +${result.signals.followerGrowth7d}`);
    console.log(`  - Casts (7d): ${result.signals.castCount7d}`);
    console.log(`  - Avg Engagement per Cast: ${result.signals.avgEngagementPerCast}`);
    console.log(`  - Days Active: ${result.signals.daysActive}`);
    console.log(`  - Channels: ${result.signals.channels.join(', ')}`);
    console.log('');
    console.log('-'.repeat(80));
    console.log('');
  }

  console.log('Summary:');
  console.log(`Total creators analyzed: ${results.length}`);
  const readyToLaunch = results.filter(r => r.recommendation === 'launch_now').length;
  const keepBuilding = results.filter(r => r.recommendation === 'keep_building').length;
  const insufficientData = results.filter(r => r.recommendation === 'insufficient_data').length;
  console.log(`  - Ready to launch: ${readyToLaunch}`);
  console.log(`  - Keep building: ${keepBuilding}`);
  console.log(`  - Insufficient data: ${insufficientData}`);
  console.log('');
  console.log('='.repeat(80));
  console.log('Dry run complete. No state written, no spending incurred.');
  console.log('='.repeat(80));
}

// Run the dry-run
runDryRun().catch(err => {
  console.error('Dry-run failed:', err);
  process.exit(1);
});
