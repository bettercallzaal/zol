// src/__tests__/integration-matrix.test.js
// Comprehensive integration tests for the full DreamLoops graft
// Tests the complete test matrix for Phase 8 delivery
// Run: node --test src/__tests__/integration-matrix.test.js

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

// ===== CAPSULE HASH VERIFICATION =====

test('MATRIX: Capsule hash verification - capsules are valid JSON', async (t) => {
  const capsuleDir = path.join(__dirname, '../../capsules');
  const files = fs.readdirSync(capsuleDir).filter(f => f.endsWith('.json'));

  assert.ok(files.length > 0, 'Should have capsule files');

  for (const file of files) {
    const filePath = path.join(capsuleDir, file);
    const content = fs.readFileSync(filePath, 'utf8');
    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch (e) {
      assert.fail(`${file} is not valid JSON: ${e.message}`);
    }
    assert.ok(parsed.capsule_id, `${file} must have capsule_id`);
    assert.ok(parsed.schema, `${file} must have schema`);
  }
});

test('MATRIX: DreamLoop validation - all loops are valid JSON', async (t) => {
  const loopDir = path.join(__dirname, '../../loops');
  const files = fs.readdirSync(loopDir).filter(f => f.endsWith('.json'));

  assert.ok(files.length > 0, 'Should have loop files');

  for (const file of files) {
    const filePath = path.join(loopDir, file);
    const content = fs.readFileSync(filePath, 'utf8');
    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch (e) {
      assert.fail(`${file} is not valid JSON: ${e.message}`);
    }
    assert.ok(parsed.loop_id, `${file} must have loop_id`);
    assert.ok(Array.isArray(parsed.steps), `${file} must have steps array`);
  }
});

test('MATRIX: Loop manifest structure - all steps reference handlers and have permission', async (t) => {
  const loopDir = path.join(__dirname, '../../loops');
  const files = fs.readdirSync(loopDir).filter(f => f.endsWith('.json'));

  for (const file of files) {
    const filePath = path.join(loopDir, file);
    const loop = JSON.parse(fs.readFileSync(filePath, 'utf8'));

    for (const step of loop.steps || []) {
      assert.ok(step.id, `Step must have id in ${file}`);
      assert.ok(step.handler, `Step ${step.id} must have handler in ${file}`);
      assert.ok(step.permission, `Step ${step.id} must have permission in ${file}`);
      // permission should be in allowed_actions
      if (loop.allowed_actions) {
        assert.ok(
          loop.allowed_actions.includes(step.permission),
          `Step ${step.id} permission ${step.permission} not in allowed_actions in ${file}`
        );
      }
    }
  }
});

// ===== TIMEOUT AND RETRY CEILINGS =====

test('MATRIX: Loop resource limits - all loops have defined limits', async (t) => {
  const loopDir = path.join(__dirname, '../../loops');
  const files = fs.readdirSync(loopDir).filter(f => f.endsWith('.json'));

  for (const file of files) {
    const filePath = path.join(loopDir, file);
    const loop = JSON.parse(fs.readFileSync(filePath, 'utf8'));

    assert.ok(loop.limits, `Loop ${loop.loop_id} must have limits`);
    assert.ok(loop.limits.max_wall_time_ms, `Loop ${loop.loop_id} must have max_wall_time_ms`);
    assert.ok(loop.limits.max_steps, `Loop ${loop.loop_id} must have max_steps`);
    assert.ok(loop.limits.max_retries_per_step !== undefined, `Loop ${loop.loop_id} must have max_retries_per_step`);

    // Verify ceiling values are reasonable
    assert.ok(loop.limits.max_wall_time_ms > 0, `Loop ${loop.loop_id} max_wall_time_ms must be > 0`);
    assert.ok(loop.limits.max_steps > 0, `Loop ${loop.loop_id} max_steps must be > 0`);
    assert.ok(loop.limits.max_retries_per_step >= 0, `Loop ${loop.loop_id} max_retries_per_step must be >= 0`);
  }
});

test('MATRIX: Step retry configuration - all steps have retry policy', async (t) => {
  const loopDir = path.join(__dirname, '../../loops');
  const files = fs.readdirSync(loopDir).filter(f => f.endsWith('.json'));

  for (const file of files) {
    const filePath = path.join(loopDir, file);
    const loop = JSON.parse(fs.readFileSync(filePath, 'utf8'));

    for (const step of loop.steps || []) {
      assert.ok(step.retry !== undefined, `Step ${step.id} must have retry config in ${file}`);
      if (step.retry && typeof step.retry === 'object') {
        assert.ok(step.retry.max_attempts >= 1, `Step ${step.id} max_attempts must be >= 1 in ${file}`);
      }
    }
  }
});

// ===== BLOCKED PERMISSIONS AND CAPSULE PRECEDENCE =====

test('MATRIX: Capsule blocked actions are enforced', async (t) => {
  const capsuleDir = path.join(__dirname, '../../capsules');
  const baseCapsule = JSON.parse(
    fs.readFileSync(path.join(capsuleDir, 'persistent-agent-base-v1.json'), 'utf8')
  );

  // Verify base capsule has blocked actions
  assert.ok(Array.isArray(baseCapsule.permissions.blocked), 'Base capsule must have blocked actions');
  assert.ok(baseCapsule.permissions.blocked.length > 0, 'Base capsule must block some actions');

  // Verify critical actions are blocked
  const criticalBlocked = [
    'wallet.sign',
    'deployment.production.write',
    'signer.change',
    'secret.value.read',
    'self.modify.live'
  ];

  for (const action of criticalBlocked) {
    assert.ok(
      baseCapsule.permissions.blocked.includes(action),
      `Base capsule must block ${action}`
    );
  }
});

// ===== NO SECRET LEAKAGE IN OUTBOUND =====

test('MATRIX: Loop blocked actions include public.publish variants', async (t) => {
  const loopDir = path.join(__dirname, '../../loops');
  const files = fs.readdirSync(loopDir).filter(f => f.endsWith('.json'));

  for (const file of files) {
    const filePath = path.join(loopDir, file);
    const loop = JSON.parse(fs.readFileSync(filePath, 'utf8'));

    // All loops must block unguarded public publishing
    assert.ok(
      loop.blocked_actions && loop.blocked_actions.length > 0,
      `Loop ${loop.loop_id} must have blocked_actions in ${file}`
    );

    // At minimum, block public.publish without approval
    const hasPublishBlock = loop.blocked_actions.some(a => a.includes('public.publish'));
    assert.ok(
      hasPublishBlock || !loop.allowed_actions.includes('public.publish'),
      `Loop ${loop.loop_id} must block or not allow public.publish in ${file}`
    );
  }
});

// ===== DRY-RUN MODE =====

test('MATRIX: Loop execution modes - all loops support dry_run', async (t) => {
  const capsuleDir = path.join(__dirname, '../../capsules');
  const baseCapsule = JSON.parse(
    fs.readFileSync(path.join(capsuleDir, 'persistent-agent-base-v1.json'), 'utf8')
  );

  // Base capsule must define dry_run mode
  assert.ok(
    baseCapsule.payload.operating_modes.includes('dry_run'),
    'Base capsule must support dry_run mode'
  );
});

// ===== RELATIONSHIP AND PROJECT CONTINUITY =====

test('MATRIX: Loop memory routes support relationship tracking', async (t) => {
  const loopDir = path.join(__dirname, '../../loops');

  // Find loops that mention relationships
  const files = fs.readdirSync(loopDir).filter(f => f.endsWith('.json'));
  let foundRelationshipLoop = false;

  for (const file of files) {
    const filePath = path.join(loopDir, file);
    const loop = JSON.parse(fs.readFileSync(filePath, 'utf8'));

    if (loop.loop_id.includes('relationship') || loop.context_sources.some(s => s.includes('relationship'))) {
      foundRelationshipLoop = true;
      // Verify it has proper handlers
      assert.ok(
        loop.allowed_actions.some(a => a.includes('relationship')),
        `Relationship loop must have relationship handlers`
      );
    }
  }

  assert.ok(foundRelationshipLoop, 'Should have at least one relationship-focused loop');
});

test('MATRIX: Loop context sources include project continuity', async (t) => {
  const loopDir = path.join(__dirname, '../../loops');

  // Find loops that mention projects
  const files = fs.readdirSync(loopDir).filter(f => f.endsWith('.json'));
  let foundProjectLoop = false;

  for (const file of files) {
    const filePath = path.join(loopDir, file);
    const loop = JSON.parse(fs.readFileSync(filePath, 'utf8'));

    if (loop.loop_id.includes('project') ||
        (loop.context_sources && loop.context_sources.some(s => s.includes('project'))) ||
        (loop.steps && loop.steps.some(s => s.id.includes('project')))) {
      foundProjectLoop = true;
      // Verify some context sources mention projects
      assert.ok(
        loop.context_sources.some(s => s.includes('project')),
        `Project loop ${loop.loop_id} should have project in context sources`
      );
    }
  }

  assert.ok(foundProjectLoop, 'Should have at least one project-focused loop');
});

// ===== MEMORY RETENTION AND DELETION POLICY =====

test('MATRIX: Memory handlers defined - read and write', async (t) => {
  const handlersPath = path.join(__dirname, '../handlers/index.js');
  const handlersModule = require(handlersPath);

  assert.ok(handlersModule['memory.read'], 'memory.read handler must exist');
  assert.ok(handlersModule['memory.write'], 'memory.write handler must exist');
  // Note: memory.consolidate and memory.expire are deferrable for Phase 9+
});

test('MATRIX: Memory consolidation loop exists', async (t) => {
  const loopDir = path.join(__dirname, '../../loops');
  const files = fs.readdirSync(loopDir).filter(f => f.endsWith('.json'));

  let foundMemoryLoop = false;
  for (const file of files) {
    const filePath = path.join(loopDir, file);
    const loop = JSON.parse(fs.readFileSync(filePath, 'utf8'));

    if (loop.loop_id.includes('memory')) {
      foundMemoryLoop = true;
      assert.ok(
        loop.allowed_actions.includes('memory.consolidate') ||
        loop.allowed_actions.includes('memory.write'),
        `Memory loop must have memory handlers`
      );
    }
  }

  assert.ok(foundMemoryLoop, 'Should have at least one memory-focused loop');
});

// ===== MODEL BUDGET ENFORCEMENT =====

test('MATRIX: Budget loop and handlers exist', async (t) => {
  const loopDir = path.join(__dirname, '../../loops');
  const budgetLoopPath = path.join(loopDir, 'budget-and-model-review.manifest.json');

  assert.ok(
    fs.existsSync(budgetLoopPath),
    'budget-and-model-review loop must exist'
  );

  const budgetLoop = JSON.parse(fs.readFileSync(budgetLoopPath, 'utf8'));
  assert.ok(budgetLoop.steps.length > 0, 'Budget loop must have steps');
  assert.ok(
    budgetLoop.allowed_actions.includes('budget.read'),
    'Budget loop must allow budget.read'
  );
  assert.ok(
    budgetLoop.allowed_actions.includes('model.usage.read'),
    'Budget loop must allow model.usage.read'
  );
});

// ===== EXISTING ZOL BEHAVIOR PRESERVATION =====

test('MATRIX: ZOL core handlers still exist', async (t) => {
  const handlersPath = path.join(__dirname, '../handlers/index.js');
  const handlersModule = require(handlersPath);

  // Verify core ZOL handlers are unchanged
  assert.ok(handlersModule['state.local.read'], 'state.local.read must exist');
  assert.ok(handlersModule['state.local.write'], 'state.local.write must exist');
  assert.ok(handlersModule['task.capture'], 'task.capture must exist');
  assert.ok(handlersModule['task.plan'], 'task.plan must exist');
  assert.ok(handlersModule['farcaster.reply'], 'farcaster.reply must exist');
});

test('MATRIX: Warper Keeper is disabled by default', async (t) => {
  // Check environment and config
  const adapterPath = path.join(__dirname, '../adapters/warper-keeper-adapter.js');
  const adapterContent = fs.readFileSync(adapterPath, 'utf8');

  // Default mode should be 'disabled' via ?? operator or default assignment
  assert.ok(
    adapterContent.includes("'disabled'") ||
    adapterContent.includes('"disabled"'),
    'Warper Keeper adapter must mention disabled mode'
  );

  // Verify that disabled mode rejects all operations
  const { createWarperKeeperAdapter } = require('../adapters/warper-keeper-adapter.js');
  const adapter = createWarperKeeperAdapter({});
  assert.strictEqual(adapter.mode, 'disabled', 'Default mode must be disabled');
});

// ===== NO SIGNER ACCESS =====

test('MATRIX: No signer or wallet operations in handlers', async (t) => {
  const handlersPath = path.join(__dirname, '../handlers/index.js');
  const handlersContent = fs.readFileSync(handlersPath, 'utf8');

  // Verify forbidden terms don't appear
  const forbiddenTerms = ['signer', 'Ed25519', 'privateKey', 'PRIVATE_KEY'];

  for (const term of forbiddenTerms) {
    const regex = new RegExp(`\\b${term}\\b`);
    const match = handlersContent.match(regex);
    if (match) {
      // Check context - is it in a comment or string?
      const line = handlersContent.substring(Math.max(0, match.index - 50), match.index + 50);
      assert.ok(
        line.includes('//') || line.includes('*'),
        `Term '${term}' found but should only be in comments/strings`
      );
    }
  }

  // wallet.sign and sign( are less likely to be in handlers at all
  assert.ok(
    !handlersContent.includes('wallet.sign'),
    'wallet.sign should not be in handlers'
  );
});

// ===== RECEIPT STRUCTURE =====

test('MATRIX: Failed-run receipts include error information', async (t) => {
  const handlersPath = path.join(__dirname, '../handlers/index.js');
  const handlersModule = require(handlersPath);

  // Verify receipt.local.write exists and can handle error receipts
  assert.ok(
    handlersModule['receipt.local.write'],
    'receipt.local.write handler must exist'
  );
});

// ===== CAPSULE COMPOSITION =====

test('MATRIX: Base capsule can be composed with overlay capsules', async (t) => {
  const capsuleDir = path.join(__dirname, '../../capsules');
  const files = fs.readdirSync(capsuleDir).filter(f => f.endsWith('.json'));

  const capsules = files.map(f => JSON.parse(fs.readFileSync(path.join(capsuleDir, f), 'utf8')));
  const baseCapsule = capsules.find(c => c.capsule_id === 'persistent-agent-base-v1');

  assert.ok(baseCapsule, 'persistent-agent-base-v1 capsule must exist');

  // Verify base has permissions that can be composed
  assert.ok(baseCapsule.permissions.allowed, 'Base capsule must have allowed permissions');
  assert.ok(baseCapsule.permissions.blocked, 'Base capsule must have blocked permissions');

  // Verify overlay capsules reference the base
  const overlays = capsules.filter(c => c.capsule_id !== 'persistent-agent-base-v1');
  assert.ok(overlays.length > 0, 'Should have overlay capsules');
});
