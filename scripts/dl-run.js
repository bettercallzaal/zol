#!/usr/bin/env node

// scripts/dl-run.js - DreamLoops activation entry with DREAMLOOPS_ENABLED flag
// This is the only place where DreamLoops lifecycle is controlled
// When flag is OFF (default), ZOL operates exactly as before
// When flag is ON, DreamLoops run according to their manifests

const fs = require('fs');
const path = require('path');

// ACTIVATION FLAG - default OFF
const DREAMLOOPS_ENABLED = process.env.DREAMLOOPS_ENABLED === '1' || process.env.DREAMLOOPS_ENABLED === 'true';

// Guard: if disabled, exit cleanly (ZOL operates normally without DreamLoops)
if (!DREAMLOOPS_ENABLED) {
  console.log('[dl-run] DREAMLOOPS_ENABLED is off. ZOL operates normally.');
  process.exit(0);
}

// ===== ACTIVE BLOCK: Only runs when DREAMLOOPS_ENABLED=1 =====

console.log('[dl-run] DREAMLOOPS_ENABLED=1. Starting DreamLoops orchestration...');

const { createStateStore } = require('../src/state-adapter');
const handlers = require('../src/handlers');

async function runDreamLoopsDaily() {
  try {
    // Dynamic import for ES module (runner)
    const { DreamLoopRunner } = await import('../vendor/dreamloops/runtime/src/runner.js');

    // Initialize state store (defaults to atomic-file, can use SQLite if better-sqlite3 available)
    const stateStore = await createStateStore();

    // Load all loop manifests and capsules
    const loopsDir = path.join(__dirname, '..', 'loops');
    const capsulesDir = path.join(__dirname, '..', 'capsules');

    const loopFiles = fs.readdirSync(loopsDir).filter(f => f.endsWith('.manifest.json'));
    console.log(`[dl-run] Found ${loopFiles.length} loop manifests`);

    // For daily operations, run these specific loops in order:
    // 1. bootstrap-agent-state (resume from last shutdown)
    // 2. morning-plan (5am trigger, but we can run anytime)
    // 3. inbox-triage (event-driven, but run once daily)
    // 4. project-continuity-resume (ensure work state is loaded)
    // 5. evening-review (daily reflection)
    // Additional loops: memory consolidation, budget review, etc.

    const scheduledLoops = [
      'bootstrap-agent-state',
      'project-continuity-resume',
      'morning-plan',
      'inbox-triage',
      'task-capture-and-plan',
      'evening-review'
    ];

    // Load primary capsule (zol-overlay-v1)
    const capsulePath = path.join(capsulesDir, 'zol-overlay-v1.json');
    const capsule = JSON.parse(fs.readFileSync(capsulePath, 'utf8'));

    console.log(`[dl-run] Using capsule: ${capsule.capsule_id} v${capsule.version}`);
    console.log(`[dl-run] Granted permissions: ${capsule.permissions.allowed.length}`);
    console.log(`[dl-run] Blocked actions: ${capsule.permissions.blocked.join(', ')}`);

    // Create runner with state store
    const runner = new DreamLoopRunner({
      handlers,
      grantedPermissions: capsule.permissions.allowed,
      stateStore
    });

    // Execute scheduled loops
    const results = [];
    for (const loopName of scheduledLoops) {
      try {
        const manifestPath = path.join(loopsDir, `${loopName}.manifest.json`);

        if (!fs.existsSync(manifestPath)) {
          console.log(`[dl-run] Skipping ${loopName}: manifest not found`);
          continue;
        }

        const loop = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

        console.log(`\n[dl-run] Executing loop: ${loop.loop_id} v${loop.version}`);
        console.log(`[dl-run]   Title: ${loop.title}`);
        console.log(`[dl-run]   Steps: ${loop.steps.length}`);
        console.log(`[dl-run]   Timeout: ${loop.limits.max_wall_time_ms}ms`);

        // Load previous state if available (continue from last run)
        const stateKey = `${loop.loop_id}-active`;

        // Execute the loop in normal (non-mock) mode
        const receipt = await runner.run({
          capsule,
          loop,
          input: {},
          executionMode: 'normal',
          stateKey
        });

        console.log(`[dl-run] Loop ${loop.loop_id}: ${receipt.status}`);
        console.log(`[dl-run]   Completed: ${receipt.steps.filter(s => s.status === 'completed').length}/${receipt.steps.length} steps`);

        // Check for failures
        const failedSteps = receipt.steps.filter(s => s.status === 'failed');
        if (failedSteps.length > 0) {
          console.log(`[dl-run]   Failed steps: ${failedSteps.length}`);
          for (const step of failedSteps) {
            console.log(`[dl-run]     - ${step.stepId}: ${step.error}`);
          }
        }

        results.push({
          loopId: loop.loop_id,
          status: receipt.status,
          steps: receipt.steps.length,
          completed: receipt.steps.filter(s => s.status === 'completed').length,
          failed: failedSteps.length
        });
      } catch (loopError) {
        console.error(`[dl-run] Loop execution failed: ${loopName}`, loopError.message);
        results.push({
          loopId: loopName,
          status: 'error',
          error: loopError.message
        });
      }
    }

    // Summary report
    console.log('\n[dl-run] === DREAMLOOPS EXECUTION SUMMARY ===');
    for (const result of results) {
      const statusStr = result.status === 'completed' ? 'OK' : result.status.toUpperCase();
      if (result.completed !== undefined) {
        console.log(`[dl-run] ${result.loopId}: ${statusStr} (${result.completed}/${result.steps} steps)`);
      } else {
        console.log(`[dl-run] ${result.loopId}: ${statusStr}`);
      }
    }

    const allCompleted = results.filter(r => r.status === 'completed').length;
    console.log(`[dl-run] Total: ${allCompleted}/${results.length} loops completed`);

    process.exit(results.some(r => r.status === 'error') ? 1 : 0);
  } catch (error) {
    console.error('[dl-run] Fatal error:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

// Run the orchestration
runDreamLoopsDaily();
