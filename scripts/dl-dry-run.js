#!/usr/bin/env node

// scripts/dl-dry-run.js - DreamLoop dry-run harness
// Wire: runtime (vendored) + handlers + capsule + loop manifest
// Usage: npm run dl:dry-run [loop-id]
// Example: npm run dl:dry-run morning-plan-v1

const fs = require('fs');
const path = require('path');
const { createStateStore } = require('../src/state-adapter');
const handlers = require('../src/handlers');

async function runDryRun() {
  // Dynamic import for ES module
  const { DreamLoopRunner } = await import('../vendor/dreamloops/runtime/src/runner.js');
  const loopIdOrName = process.argv[2];

  // Load capsule
  const capsulePath = path.join(__dirname, '..', 'capsules', 'zol-overlay-v1.json');
  const capsule = JSON.parse(fs.readFileSync(capsulePath, 'utf8'));

  // Load loop manifest
  let loopPath;
  let loop;

  if (loopIdOrName) {
    // Try exact match first
    const tryPath = path.join(__dirname, '..', 'loops', `${loopIdOrName}.manifest.json`);
    if (fs.existsSync(tryPath)) {
      loopPath = tryPath;
      loop = JSON.parse(fs.readFileSync(loopPath, 'utf8'));
    } else {
      // Try to find by loop_id inside JSON
      const loopsDir = path.join(__dirname, '..', 'loops');
      const files = fs.readdirSync(loopsDir);
      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        const filePath = path.join(loopsDir, file);
        try {
          const content = JSON.parse(fs.readFileSync(filePath, 'utf8'));
          if (content.loop_id === loopIdOrName) {
            loopPath = filePath;
            loop = content;
            break;
          }
        } catch (e) {
          console.error(`[dry-run] Error parsing ${file}:`, e.message);
        }
      }
    }
  } else {
    // Default to bootstrap for testing
    loopPath = path.join(__dirname, '..', 'loops', 'bootstrap-agent-state.manifest.json');
    loop = JSON.parse(fs.readFileSync(loopPath, 'utf8'));
  }

  if (!loop) {
    console.error(`[dry-run] Loop not found: ${loopIdOrName}`);
    process.exit(1);
  }

  console.log(`[dry-run] Loading: ${loop.loop_id} v${loop.version}`);
  console.log(`[dry-run] Capsule: ${capsule.capsule_id} v${capsule.version}`);

  // For dry-run (mock mode), don't persist state to avoid secret pattern issues in test data
  // stateStore = null means no persistence, just execution
  const stateStore = null;

  // Create runner with granted permissions
  console.log(`[dry-run] Granting ${capsule.permissions.allowed.length} permissions`);
  const runner = new DreamLoopRunner({
    handlers,
    grantedPermissions: capsule.permissions.allowed,
    stateStore
  });

  try {
    console.log(`[dry-run] Starting execution (mode: mock, timeout: ${loop.limits.max_wall_time_ms}ms)...`);
    const receipt = await runner.run({
      capsule,
      loop,
      input: {
        testMode: true,
        dryRun: true
      },
      executionMode: 'mock',
      stateKey: `${loop.loop_id}-dry-run`
    });

    console.log('\n[dry-run] RECEIPT:');
    console.log(JSON.stringify(receipt, null, 2));

    console.log(`\n[dry-run] Status: ${receipt.status}`);
    console.log(`[dry-run] Steps completed: ${receipt.steps.length}/${loop.steps.length}`);

    const failedSteps = receipt.steps.filter(s => s.status === 'failed');
    if (failedSteps.length > 0) {
      console.log(`[dry-run] Failed steps: ${failedSteps.length}`);
      failedSteps.forEach(s => {
        console.log(`  - ${s.stepId}: ${s.error}`);
      });
    }

    process.exit(receipt.status === 'completed' ? 0 : 1);
  } catch (error) {
    console.error('[dry-run] ERROR:', error.message);
    if (error.receipt) {
      console.error('[dry-run] Receipt:');
      console.error(JSON.stringify(error.receipt, null, 2));
    }
    process.exit(1);
  }
}

runDryRun().catch(err => {
  console.error('[dry-run] Fatal error:', err);
  process.exit(1);
});
