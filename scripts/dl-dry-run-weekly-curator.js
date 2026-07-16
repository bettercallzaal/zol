#!/usr/bin/env node
// scripts/dl-dry-run-weekly-curator.js - Dry-run the weekly-curator loop
// Exercises all handlers in mock mode, verifies safety guards, checks output structure

const { weeklycurator } = require('../src/handlers/weekly-curator');

const colors = { reset: '\x1b[0m', green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m', blue: '\x1b[34m' };
function log(msg, color = 'reset') { console.log(`${colors[color]}${msg}${colors.reset}`); }

async function runDryRun() {
  log('\n=== Weekly Curator Loop - Dry Run ===\n', 'blue');
  let passed = 0, failed = 0;
  const check = async (label, fn) => {
    try { log(`Test: ${label}`, 'yellow'); await fn(); log('  PASS', 'green'); passed++; }
    catch (error) { log(`  FAIL: ${error.message}`, 'red'); failed++; }
  };

  await check('state.local.read - initial state has empty summarizedWeeks', async () => {
    const r = await weeklycurator['state.local.read']({ input: { key: 'weekly-curator-state' }, state: {}, signal: null });
    if (!r.success || !Array.isArray(r.state.summarizedWeeks)) throw new Error('missing summarizedWeeks');
  });

  await check('state.local.write - records week summarized', async () => {
    const r = await weeklycurator['state.local.write']({
      input: { key: 'weekly-curator-state', updateType: 'week-summarized', immutableLog: true },
      state: {}, executionMode: 'mock',
    });
    if (!r.success) throw new Error('write failed');
  });

  await check('state.local.write - rejects secret patterns', async () => {
    try {
      await weeklycurator['state.local.write']({
        input: { key: 'weekly-curator-state', updateType: 'week-summarized', secret: '0x1234567890abcdef0123456789abcdef0123456789abcdef0123456789abcdef' },
        state: {}, executionMode: 'live',
      });
      throw new Error('should have thrown on secret pattern');
    } catch (e) { if (!e.message.includes('SECURITY')) throw e; }
  });

  await check('state.local.write - blocks draftOnly=false (safety)', async () => {
    try {
      await weeklycurator['state.local.write']({
        input: { key: 'weekly-curator-draft', draftOnly: false, kind: 'weekly-recap' },
        state: {}, executionMode: 'mock',
      });
      throw new Error('should have thrown on draftOnly=false');
    } catch (e) { if (!e.message.includes('SAFETY')) throw e; }
  });

  await check('state.local.write - stages draft for approval', async () => {
    const r = await weeklycurator['state.local.write']({
      input: { key: 'weekly-curator-draft', draftOnly: true, kind: 'weekly-recap' },
      state: {}, executionMode: 'mock',
    });
    if (!r.success || r.status !== 'staged-for-approval') throw new Error('did not stage for approval');
  });

  await check('farcaster.activity-read - reads recent casts (7d window)', async () => {
    const r = await weeklycurator['farcaster.activity-read']({ input: { source: 'recent-casts-file', timeWindowDays: 7 }, state: {}, signal: null });
    if (!r.success || !Array.isArray(r.casts)) throw new Error('missing casts');
    log(`    - ${r.casts.length} cast(s) in window`);
  });

  await check('farcaster.activity-read - recalls Bonfire context', async () => {
    const r = await weeklycurator['farcaster.activity-read']({ input: { source: 'bonfire-recall', query: 'ZAO music curators, standout tracks, and artist wins this week' }, state: {}, signal: null });
    if (!r.success || typeof r.context !== 'string' || !r.context.length) throw new Error('missing context');
  });

  await check('message.classify - selects best find of week', async () => {
    const r = await weeklycurator['message.classify']({ input: { types: ['best-find-of-week', 'artist-spotlight', 'track-recommendation'], contextKey: 'weekly-curator-highlight' }, state: {}, signal: null });
    if (!r.success || !r.classifications?.['best-find-of-week']?.selected) throw new Error('missing highlight selection');
  });

  await check('message.classify - checks similarity to previous recaps', async () => {
    const r = await weeklycurator['message.classify']({ input: { types: ['duplicate-check'], contextKey: 'weekly-recap-similarity' }, state: {}, signal: null });
    if (typeof r.isSimilar !== 'boolean') throw new Error('missing isSimilar');
  });

  await check('priority.plan - allows proceeding when week not yet summarized', async () => {
    const r = await weeklycurator['priority.plan']({ input: { scope: 'weekly-recap-check', checkForDuplicateWeek: true }, state: { summarizedWeeks: [] }, signal: null });
    if (!r.success || !r.canProceed) throw new Error('expected canProceed');
  });

  await check('priority.plan - composes draft text (<=280 chars)', async () => {
    const r = await weeklycurator['priority.plan']({ input: { scope: 'weekly-recap-composition', draftOnly: true, maxLength: 280 }, state: {}, signal: null });
    if (!r.success || !r.draftText || r.textLength > 280) throw new Error('bad draft composition');
    log(`    - "${r.draftText.slice(0, 80)}${r.draftText.length > 80 ? '...' : ''}"`);
  });

  await check('priority.plan - blocks auto-send (safety)', async () => {
    try {
      await weeklycurator['priority.plan']({ input: { scope: 'weekly-recap-composition', draftOnly: false, maxLength: 280 }, state: {}, signal: null });
      throw new Error('should have thrown on draftOnly=false');
    } catch (e) { if (!e.message.includes('SAFETY')) throw e; }
  });

  await check('log.zol-events-write - records events', async () => {
    const r = await weeklycurator['log.zol-events-write']({ input: { eventType: 'weekly-recap-drafted', includeResult: true }, state: {}, executionMode: 'mock' });
    if (!r.success || !r.logged) throw new Error('event not logged');
  });

  await check('log.zol-events-write - blocks secret patterns', async () => {
    try {
      await weeklycurator['log.zol-events-write']({ input: { eventType: 'test', secret: 'sk-1234567890abcdef1234567890abcdef' }, state: {}, executionMode: 'live' });
      throw new Error('should have thrown on secret pattern');
    } catch (e) { if (!e.message.includes('SECURITY')) throw e; }
  });

  log(`\n=== ${passed} passed, ${failed} failed ===\n`, failed ? 'red' : 'green');
  process.exit(failed ? 1 : 0);
}

runDryRun();
