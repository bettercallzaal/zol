#!/usr/bin/env node

// scripts/dl-run-weekly.js - weekly-cadence DreamLoops entry point.
//
// WHY THIS EXISTS SEPARATELY FROM dl-run.js: that script's scheduledLoops
// array only covers the generic persistent-agent loops (bootstrap-agent-state,
// morning-plan, etc), all intended to run on every daily invocation. The
// domain-specific loops built for ZOL - weekly-curator-v1 (trigger:
// "scheduled weekly (Monday 6am UTC)") and artist-spotlight-v1 (trigger:
// "scheduled weekly on-demand") - declare a weekly cadence in their own
// manifests, so they don't belong in a script meant to run once a day.
// This script is the weekly counterpart, meant to be invoked by a weekly
// cron entry or systemd timer (not yet wired to either - that's still a
// deploy-time decision, see deploy/ in this repo).
//
// Same double-flag-gate discipline as dl-run.js: nothing runs unless
// DREAMLOOPS_ENABLED is on AND the specific loop's own flag is on. Each
// loop uses its OWN capsule (zol-weekly-curator-v1 / zol-artist-spotlight-v1),
// not the shared zol-overlay-v1 capsule dl-run.js uses for the generic loops.

const fs = require('fs');
const path = require('path');

const DREAMLOOPS_ENABLED = process.env.DREAMLOOPS_ENABLED === '1' || process.env.DREAMLOOPS_ENABLED === 'true';

if (!DREAMLOOPS_ENABLED) {
  console.log('[dl-run-weekly] DREAMLOOPS_ENABLED is off. ZOL operates normally.');
  process.exit(0);
}

const { createStateStore } = require('../src/state-adapter');

// WHY EACH LOOP GETS ITS OWN DEDICATED HANDLER MAP, NEVER MERGED: several
// domain loops independently define handler keys with the SAME name but
// DIFFERENT behavior - e.g. 'state.local.read'/'state.local.write' exist
// separately in src/handlers/index.js (generic loops), weekly-curator.js,
// AND artist-spotlight.js. Merging any of these into one shared object
// (the way dl-run.js does for the generic loops, which don't collide)
// would silently shadow one loop's implementation with another's. Each
// entry below gets its own runner instance with only its own handlers.
const WEEKLY_LOOPS = [
  {
    loopId: 'weekly-curator-v1',
    flagEnv: 'WEEKLY_CURATOR_ENABLED',
    capsuleFile: 'zol-weekly-curator-v1.json',
    handlers: require('../src/handlers/weekly-curator').weeklycurator,
  },
  {
    loopId: 'artist-spotlight-v1',
    flagEnv: 'ARTIST_SPOTLIGHT_ENABLED',
    capsuleFile: 'zol-artist-spotlight-v1.json',
    handlers: require('../src/handlers/artist-spotlight').artistspotlight,
  },
];

function flagOn(name) {
  return process.env[name] === '1' || process.env[name] === 'true';
}

async function runWeeklyLoops() {
  const enabled = WEEKLY_LOOPS.filter((l) => flagOn(l.flagEnv));
  if (!enabled.length) {
    console.log('[dl-run-weekly] DREAMLOOPS_ENABLED=1 but no weekly loop flag is set. Nothing to run.');
    console.log(`[dl-run-weekly]   Set one of: ${WEEKLY_LOOPS.map((l) => l.flagEnv).join(', ')}`);
    process.exit(0);
  }

  console.log(`[dl-run-weekly] Running ${enabled.length} weekly loop(s): ${enabled.map((l) => l.loopId).join(', ')}`);

  try {
    const { DreamLoopRunner } = await import('../vendor/dreamloops/runtime/src/runner.js');
    const stateStore = await createStateStore();
    const loopsDir = path.join(__dirname, '..', 'loops');
    const capsulesDir = path.join(__dirname, '..', 'capsules');

    const results = [];
    for (const { loopId, capsuleFile, handlers } of enabled) {
      try {
        const manifestPath = path.join(loopsDir, `${loopId}.manifest.json`);
        const capsulePath = path.join(capsulesDir, capsuleFile);
        if (!fs.existsSync(manifestPath)) { console.log(`[dl-run-weekly] Skipping ${loopId}: manifest not found`); continue; }
        if (!fs.existsSync(capsulePath)) { console.log(`[dl-run-weekly] Skipping ${loopId}: capsule not found`); continue; }

        const loop = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        const capsule = JSON.parse(fs.readFileSync(capsulePath, 'utf8'));

        console.log(`\n[dl-run-weekly] Executing loop: ${loop.loop_id} v${loop.version}`);
        console.log(`[dl-run-weekly]   Capsule: ${capsule.capsule_id} (status: ${capsule.status})`);
        console.log(`[dl-run-weekly]   Steps: ${loop.steps.length}, timeout: ${loop.limits.max_wall_time_ms}ms`);

        // Dedicated runner per loop - see WEEKLY_LOOPS comment above for why
        // handlers are never merged across loops.
        const runner = new DreamLoopRunner({ handlers, grantedPermissions: capsule.permissions.allowed, stateStore });
        const stateKey = `${loop.loop_id}-active`;
        const receipt = await runner.run({ capsule, loop, input: {}, executionMode: 'normal', stateKey });

        console.log(`[dl-run-weekly] Loop ${loop.loop_id}: ${receipt.status}`);
        const failedSteps = receipt.steps.filter((s) => s.status === 'failed');
        if (failedSteps.length) {
          console.log(`[dl-run-weekly]   Failed steps: ${failedSteps.length}`);
          for (const step of failedSteps) console.log(`[dl-run-weekly]     - ${step.stepId}: ${step.error}`);
        }
        results.push({ loopId: loop.loop_id, status: receipt.status, failed: failedSteps.length });
      } catch (loopError) {
        console.error(`[dl-run-weekly] Loop execution failed: ${loopId}`, loopError.message);
        results.push({ loopId, status: 'error', error: loopError.message });
      }
    }

    console.log('\n[dl-run-weekly] === WEEKLY LOOPS SUMMARY ===');
    for (const r of results) console.log(`[dl-run-weekly] ${r.loopId}: ${r.status.toUpperCase()}`);

    process.exit(results.some((r) => r.status === 'error' || r.failed) ? 1 : 0);
  } catch (error) {
    console.error('[dl-run-weekly] Fatal error:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

runWeeklyLoops();
