#!/usr/bin/env node
// scripts/dl-dry-run-board-triage.js - Dry-run the board-triage-nightly loop
// Exercises all board.* handlers in mock/offline mode, verifies safety guards, checks output structure.
// No real network calls if COWORK_TRACKER_URL is unset.

const { CoworkTracker } = require('../src/cowork-tracker');
const handlers = require('../src/handlers/index');

const colors = { reset: '\x1b[0m', green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m', blue: '\x1b[34m' };
function log(msg, color = 'reset') { console.log(`${colors[color]}${msg}${colors.reset}`); }

const FAKE_ROWS = [
  { id: 'a1', title: 'Fix the auth bug', status: 'todo', priority: 'P1', category: 'ZAO Devz' },
  { id: 'a2', title: 'Fix the auth bug', status: 'in_progress', priority: 'P1', category: 'ZAO Devz' },
  { id: 'b1', title: 'Write onboarding docs', status: 'todo', priority: 'P2', category: 'Ops' },
  { id: 'c1', title: 'Blocked task — waiting on decision', status: 'blocked', priority: 'P1', category: 'Other' },
];

async function runDryRun() {
  log('\n=== Board Triage Nightly - Dry Run ===\n', 'blue');
  let passed = 0, failed = 0;

  const check = async (label, fn) => {
    try {
      log(`Test: ${label}`, 'yellow');
      await fn();
      log('  PASS', 'green');
      passed++;
    } catch (err) {
      log(`  FAIL: ${err.message}`, 'red');
      failed++;
    }
  };

  // ---- CoworkTracker offline (no env vars) ----

  await check('CoworkTracker: missing config returns ok:false without throwing', async () => {
    const tracker = new CoworkTracker({ baseUrl: '', apiKey: '' });
    const r = await tracker.listOpen();
    if (r.ok) throw new Error('expected ok:false with no config');
    if (!r.error.includes('not configured')) throw new Error(`unexpected error: ${r.error}`);
  });

  // ---- triage() with injected data ----

  await check('CoworkTracker.triage: detects duplicate titles', async () => {
    const tracker = new CoworkTracker({ baseUrl: 'https://fake.example', apiKey: 'fake' });
    tracker._req = async () => ({ ok: true, data: FAKE_ROWS });
    const r = await tracker.triage({ topN: 10 });
    if (!r.ok) throw new Error(`triage failed: ${r.error}`);
    if (r.total !== 4) throw new Error(`expected 4 total rows, got ${r.total}`);
    if (r.duplicateCount < 1) throw new Error(`expected >= 1 duplicate, got ${r.duplicateCount}`);
    log(`    total=${r.total} top=${r.top.length} dupes=${r.duplicateCount}`, 'green');
  });

  await check('CoworkTracker.triage: excludes blocked tasks from top', async () => {
    const tracker = new CoworkTracker({ baseUrl: 'https://fake.example', apiKey: 'fake' });
    tracker._req = async () => ({ ok: true, data: FAKE_ROWS });
    const r = await tracker.triage({ topN: 10 });
    if (!r.ok) throw new Error(`triage failed: ${r.error}`);
    if (r.top.some(t => t.status === 'blocked')) throw new Error('blocked task appeared in top');
  });

  // ---- handler surface ----

  await check('board.triage.run handler: registered and fire-and-forget safe', async () => {
    const r = await handlers['board.triage.run']({ input: { topN: 5 } });
    if (typeof r.ok !== 'boolean') throw new Error('handler must return { ok }');
    log(`    ok=${r.ok} (ok:false expected without board config)`, 'green');
  });

  await check('board.task.list-open handler: registered and fire-and-forget safe', async () => {
    const r = await handlers['board.task.list-open']({ input: {} });
    if (typeof r.ok !== 'boolean') throw new Error('handler must return { ok }');
    log(`    ok=${r.ok}`, 'green');
  });

  await check('board.task.create handler: missing title returns ok:false', async () => {
    const r = await handlers['board.task.create']({ input: {} });
    if (r.ok) throw new Error('expected ok:false for missing title');
    if (!r.error.includes('title is required')) throw new Error(`unexpected error: ${r.error}`);
  });

  await check('board.task.finish handler: missing id returns ok:false', async () => {
    const r = await handlers['board.task.finish']({ input: {} });
    if (r.ok) throw new Error('expected ok:false for missing id');
    if (!r.error.includes('id is required')) throw new Error(`unexpected error: ${r.error}`);
  });

  await check('board.task.update handler: missing fields returns ok:false', async () => {
    const r = await handlers['board.task.update']({ input: { id: 'x' } });
    if (r.ok) throw new Error('expected ok:false for missing fields');
    if (!r.error.includes('fields object required')) throw new Error(`unexpected error: ${r.error}`);
  });

  // ---- summary ----

  log(`\n=== Results: ${passed} passed, ${failed} failed ===`, failed > 0 ? 'red' : 'green');
  if (failed > 0) process.exit(1);
}

runDryRun().catch(err => { console.error('Dry run crashed:', err); process.exit(1); });
