#!/usr/bin/env node
// scripts/dl-dry-run-artist-spotlight.js - Dry-run the artist-spotlight loop
// Exercises all handlers in mock mode, verifies safety guards and the
// multi-run cooldown/rotation state carryover (this loop's core feature).

const { artistspotlight } = require('../src/handlers/artist-spotlight');

const colors = { reset: '\x1b[0m', green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m', blue: '\x1b[34m' };
function log(msg, color = 'reset') { console.log(`${colors[color]}${msg}${colors.reset}`); }

async function runDryRun() {
  log('\n=== Artist Spotlight Loop - Dry Run ===\n', 'blue');
  let passed = 0, failed = 0;
  const check = async (label, fn) => {
    try { log(`Test: ${label}`, 'yellow'); await fn(); log('  PASS', 'green'); passed++; }
    catch (error) { log(`  FAIL: ${error.message}`, 'red'); failed++; }
  };

  await check('state.local.read - handles empty history', async () => {
    const r = await artistspotlight['state.local.read']({ input: { stateKey: 'artist-spotlight-v1-history' }, state: {}, signal: null });
    if (!r.success || r.history.length !== 0) throw new Error('expected empty history');
  });

  await check('state.local.write - persists state', async () => {
    const r = await artistspotlight['state.local.write']({
      input: { stateKey: 'artist-spotlight-v1-history', value: { artist: 'Artist C', spotlightedAt: new Date().toISOString() }, appendMode: true },
      state: {}, executionMode: 'mock', signal: null,
    });
    if (!r.success) throw new Error('write failed');
  });

  await check('state.local.write - rejects secret patterns', async () => {
    try {
      await artistspotlight['state.local.write']({
        input: { stateKey: 'test', value: { secret: '0x1234567890abcdef0123456789abcdef0123456789abcdef0123456789abcdef' } },
        state: {}, executionMode: 'live', signal: null,
      });
      throw new Error('should have thrown on secret pattern');
    } catch (e) { if (!e.message.includes('SECURITY')) throw e; }
  });

  await check('bonfire.delve-recall - fetches artist context', async () => {
    const r = await artistspotlight['bonfire.delve-recall']({ input: { query: 'ZAO artists collaborations and community members to spotlight', maxEpisodes: 15 }, state: {}, signal: null });
    if (!r.success || !r.context) throw new Error('missing context');
  });

  await check('farcaster.recent-casts-parse - extracts artist candidates', async () => {
    const r = await artistspotlight['farcaster.recent-casts-parse']({ input: { recentPath: '~/zol/recent-casts.json', extractArtists: true }, state: {}, signal: null });
    if (!r.success || !Array.isArray(r.artists) || !r.artists.length) throw new Error('no artists extracted');
    log(`    - ${r.artists.length} candidate(s)`);
  });

  await check('filter-eligible-artists - excludes recent spotlights (60d cooldown)', async () => {
    const state = { 'artist-spotlight-v1-history': [
      { artist: 'Artist A', spotlightedAt: new Date(Date.now() - 30 * 864e5).toISOString() },
      { artist: 'Artist B', spotlightedAt: new Date(Date.now() - 100 * 864e5).toISOString() },
    ] };
    const r = await artistspotlight['artist-spotlight.filter-eligible-artists']({ input: { cooldownDays: 60, historyState: 'artist-spotlight-v1-history' }, state, signal: null });
    if (!r.success || r.eligible.some((a) => a.toLowerCase() === 'artist a')) throw new Error('cooldown not enforced');
  });

  await check('filter-eligible-artists - throws when nobody is eligible', async () => {
    const now = new Date().toISOString();
    const state = { 'artist-spotlight-v1-history': ['Ivy Wong', 'Marcus Chen', 'Lila Rossi', 'Amir Khalil', 'Sofia Delgado'].map((artist) => ({ artist, spotlightedAt: now })) };
    try {
      await artistspotlight['artist-spotlight.filter-eligible-artists']({ input: { cooldownDays: 60, historyState: 'artist-spotlight-v1-history' }, state, signal: null });
      throw new Error('should have thrown when no eligible artists');
    } catch (e) { if (!e.message.includes('SAFETY')) throw e; }
  });

  await check('select-one-artist - picks from candidates', async () => {
    const r = await artistspotlight['artist-spotlight.select-one-artist']({ input: { weightRandom: true, candidates: { eligible: ['Artist A', 'Artist B', 'Artist C'] } }, state: {}, signal: null });
    if (!r.success || !['Artist A', 'Artist B', 'Artist C'].includes(r.selectedArtist)) throw new Error('bad selection');
  });

  await check('compose-spotlight-draft - composes draft text (<=280 chars)', async () => {
    const r = await artistspotlight['artist-spotlight.compose-spotlight-draft']({ input: { maxLength: 280, draftOnly: true, selectedArtist: 'Ivy Wong' }, state: {}, signal: null });
    if (!r.success || !r.draftText.includes('Ivy Wong') || r.textLength > 280) throw new Error('bad draft');
    log(`    - "${r.draftText.slice(0, 80)}${r.draftText.length > 80 ? '...' : ''}"`);
  });

  await check('compose-spotlight-draft - blocks auto-post (safety)', async () => {
    try {
      await artistspotlight['artist-spotlight.compose-spotlight-draft']({ input: { maxLength: 280, draftOnly: false, selectedArtist: 'Marcus Chen' }, state: {}, signal: null });
      throw new Error('should have thrown on auto-post');
    } catch (e) { if (!e.message.includes('SAFETY')) throw e; }
  });

  await check('stage-draft-for-approval - stages into ~/zol/drafts (no write in dry-run)', async () => {
    const r = await artistspotlight['artist-spotlight.stage-draft-for-approval']({
      input: { draftsDirectory: '~/zol/drafts', draftKind: 'artist-spotlight', draftText: 'Spotlight: Lila Rossi - a talented vocalist.', selectedArtist: 'Lila Rossi', writeFile: false },
      state: {}, executionMode: 'mock', signal: null,
    });
    if (!r.success || !r.hash || r.artist !== 'Lila Rossi') throw new Error('did not stage correctly');
  });

  await check('record-spotlight-completion - records completion event', async () => {
    const r = await artistspotlight['artist-spotlight.record-spotlight-completion']({ input: { eventType: 'artist-spotlight-drafted', selectedArtist: 'Amir Khalil', draftHash: 'abc123def456' }, state: {}, executionMode: 'mock', signal: null });
    if (!r.success || r.completionRecord?.artist !== 'Amir Khalil') throw new Error('completion not recorded');
  });

  await check('multi-run carryover - 3 sequential runs never repeat an artist within cooldown', async () => {
    let state = { 'artist-spotlight-v1-history': [] };
    const picks = [];
    const candidates = { eligible: ['Ivy Wong', 'Marcus Chen', 'Lila Rossi'] };
    for (let i = 0; i < 3; i++) {
      const filtered = i === 0 ? candidates : await artistspotlight['artist-spotlight.filter-eligible-artists']({ input: { cooldownDays: 60, historyState: 'artist-spotlight-v1-history' }, state, signal: null });
      const picked = await artistspotlight['artist-spotlight.select-one-artist']({ input: { weightRandom: true, candidates: filtered }, state, signal: null });
      if (picks.includes(picked.selectedArtist)) throw new Error(`repeated artist on run ${i + 1}: ${picked.selectedArtist}`);
      picks.push(picked.selectedArtist);
      state['artist-spotlight-v1-history'].push({ artist: picked.selectedArtist, spotlightedAt: new Date().toISOString() });
    }
    log(`    - rotation: ${picks.join(' -> ')}`);
  });

  log(`\n=== ${passed} passed, ${failed} failed ===\n`, failed ? 'red' : 'green');
  process.exit(failed ? 1 : 0);
}

runDryRun();
