#!/usr/bin/env node

/**
 * test-wins-spotter-dryrun.js - End-to-end dry run of the Community Wins Spotlight loop
 *
 * This demonstrates the full loop behavior without touching Bonfire or disk.
 * It simulates discovering wins and generating a celebratory draft.
 *
 * Usage:
 *   node scripts/test-wins-spotter-dryrun.js
 */

const {
  parseWinEpisode,
  detectPatterns,
  draftCelebration,
  validateDraft,
} = require('./zao-wins-spotter');

// Mock Bonfire episodes simulating yesterday's wins in ZAO ecosystem
const mockBonfireEpisodes = [
  {
    name: 'zol-state:abc123',
    content: `Iman shipped the Juke integration layer for POIDH - audio files now route through decentralized infrastructure.
      Community tested it live yesterday, zero errors. This unblocks the bounty judging flow.`,
    created_at: '2026-07-13T22:00:00Z',
  },
  {
    name: 'zol-state:def456',
    content: `Tyler at Magnetiq launched the ZABAL Games workshop booking integration.
      Mentors can now schedule live sessions directly from the platform. First 5 booked already.`,
    created_at: '2026-07-13T20:30:00Z',
  },
  {
    name: 'zol-state:ghi789',
    content: `Fractal architecture whitepaper revision complete.
      Zaal synthesized feedback from 8 builders. Vision document now aligns with web3 community governance patterns.`,
    created_at: '2026-07-13T18:45:00Z',
  },
  {
    name: 'zol-state:jkl012',
    content: `COC Concertz booked The Flaming Lips for ZAO-PALOOZA pre-party.
      Partnership with Thy Revolution opens 40-person capacity shows across Bay Area summer.`,
    created_at: '2026-07-13T16:20:00Z',
  },
  {
    name: 'zol-state:mno345',
    content: `ZAOstock production audit passed.
      Wed Oct 3 at Franklin St Parklet: $5-25K budget, 8 team members confirmed, ticketing live next week.`,
    created_at: '2026-07-13T14:00:00Z',
  },
];

async function dryRun() {
  console.log('================================================================================');
  console.log('ZAO Community Wins Spotlight - Dry Run Demo');
  console.log('================================================================================\n');

  console.log('Step 1: Simulating Bonfire Discovery');
  console.log(`Found ${mockBonfireEpisodes.length} episodes from last 24 hours.\n`);

  // Parse and score each episode
  console.log('Step 2: Parsing Episodes & Scoring Wins\n');
  const wins = mockBonfireEpisodes
    .map((ep) => {
      const parsed = parseWinEpisode(ep);
      console.log(
        `- "${ep.name.substring(0, 30)}" | Score: ${parsed.score.toFixed(2)} | "${parsed.content.substring(0, 60)}..."`
      );
      return parsed;
    })
    .filter((w) => w.score >= 0.7)
    .sort((a, b) => b.score - a.score);

  console.log(`\nFiltered to ${wins.length} high-confidence wins (threshold: 0.7+)\n`);

  // Detect patterns
  console.log('Step 3: Detecting Ecosystem Patterns\n');
  const patterns = detectPatterns(wins);
  console.log('Patterns detected:');
  patterns.patterns.forEach((p) => {
    console.log(`- ${p.theme}: ${(p.strength * 100).toFixed(0)}% signal strength`);
  });
  console.log();

  // Generate template draft (since we're offline)
  console.log('Step 4: Composing Celebration Cast\n');
  const topWins = wins.slice(0, 2);
  const topPattern = patterns.patterns[0];

  let draft = `Spotted in the ZAO ecosystem (last 24h):\n\n`;
  draft += `${topWins.map((w) => `• ${w.content.split('\n')[0]}`).join('\n')}\n\n`;
  draft += topPattern
    ? `Main energy right now: ${topPattern.theme.replace(/_/g, ' ')}.`
    : 'Diverse momentum across the ecosystem.';

  console.log('Generated Draft:');
  console.log('-'.repeat(80));
  console.log(draft);
  console.log('-'.repeat(80));
  console.log();

  // Validate
  console.log('Step 5: Validating Draft\n');
  const validation = validateDraft(draft);
  console.log(`Validation: ${validation.valid ? 'PASS' : 'FAIL'}`);
  if (!validation.valid) {
    console.log(`Issues: ${validation.issues.join(', ')}`);
  }
  console.log();

  // Receipt
  console.log('Step 6: Recording Receipt\n');
  const receipt = {
    timestamp: new Date().toISOString(),
    winsDiscovered: wins.length,
    patternsDetected: patterns.patterns.length,
    draftGenerated: true,
    draftValid: validation.valid,
    topTheme: topPattern?.theme,
  };

  console.log('Receipt:');
  console.log(JSON.stringify(receipt, null, 2));
  console.log();

  console.log('================================================================================');
  console.log('Dry Run Complete - Loop would store draft for Zaal to review and approve');
  console.log('================================================================================');
}

dryRun().catch((err) => {
  console.error('Dry run failed:', err);
  process.exit(1);
});
