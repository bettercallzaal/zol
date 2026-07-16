#!/usr/bin/env node
// scripts/dl-dry-run-community-crm.js - Dry-run the community-crm relationship-lifecycle-update loop
// Exercises all handlers in mock mode, verifies safety guards, checks output structure

const fs = require('fs');
const path = require('path');

// Import handlers
const { communitycrm, RELATIONSHIP_STAGES } = require('../src/handlers/community-crm');

// Colors for terminal output
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  blue: '\x1b[34m',
};

function log(msg, color = 'reset') {
  console.log(`${colors[color]}${msg}${colors.reset}`);
}

// Mock AbortSignal for handlers that accept it
class MockAbortSignal extends EventTarget {
  constructor() {
    super();
    this.aborted = false;
  }
}

async function runDryRun() {
  log('\n=== Community CRM Relationship Lifecycle Loop - Dry Run ===\n', 'blue');

  let passed = 0;
  let failed = 0;

  // Test 1: Read relationship status
  try {
    log('Test 1: circle.relationship-status-read', 'yellow');
    const result = await communitycrm['circle.relationship-status-read']({
      input: { memberId: 'test-member-001' },
      state: {},
      signal: new MockAbortSignal(),
    });

    if (result.success && result.relationship) {
      log('  PASS: Successfully read member relationship status', 'green');
      log(`    - Member: ${result.relationship.memberId}`);
      log(`    - Stage: ${result.relationship.stage}`);
      log(`    - Activity Score: ${result.relationship.activityScore}`);
      passed++;
    } else {
      throw new Error('Missing result fields');
    }
  } catch (error) {
    log(`  FAIL: ${error.message}`, 'red');
    failed++;
  }

  // Test 2: Classify relationship stage
  try {
    log('\nTest 2: message.classify (relationship stages)', 'yellow');
    const result = await communitycrm['message.classify']({
      input: {
        types: ['discover', 'engage', 'coordinate', 'escalate', 'nurture'],
        contextKey: 'relationship-lifecycle-stages',
      },
      state: {},
      signal: new MockAbortSignal(),
    });

    if (result.success && result.classifications) {
      log('  PASS: Successfully classified relationship stages', 'green');
      log(`    - Classifications: ${Object.keys(result.classifications).join(', ')}`);
      passed++;
    } else {
      throw new Error('Missing classifications');
    }
  } catch (error) {
    log(`  FAIL: ${error.message}`, 'red');
    failed++;
  }

  // Test 3: Plan nurture action
  try {
    log('\nTest 3: priority.plan (relationship action)', 'yellow');
    const result = await communitycrm['priority.plan']({
      input: {
        scope: 'relationship-lifecycle-action',
        stageAware: true,
      },
      state: {},
      signal: new MockAbortSignal(),
    });

    if (result.success && result.actionProposed) {
      log('  PASS: Successfully planned relationship action', 'green');
      log(`    - Action: ${result.actionProposed}`);
      log(`    - Priority: ${result.priority}`);
      passed++;
    } else {
      throw new Error('Missing action plan');
    }
  } catch (error) {
    log(`  FAIL: ${error.message}`, 'red');
    failed++;
  }

  // Test 4: DM send (draft-only)
  try {
    log('\nTest 4: farcaster.dm-send (draft-only, no auto-send)', 'yellow');
    const result = await communitycrm['farcaster.dm-send']({
      input: {
        recipientFid: 'fid-123',
        message: 'Hello! Welcome to The ZAO community.',
        draftOnly: true,
      },
      state: {},
      executionMode: 'mock',
      signal: new MockAbortSignal(),
    });

    if (result.success && result.draftOnly && result.status.includes('draft')) {
      log('  PASS: DM composed as draft (not auto-sent)', 'green');
      log(`    - Status: ${result.status}`);
      log(`    - Message preview: "${result.message.substring(0, 50)}..."`);
      passed++;
    } else {
      throw new Error('Draft flag not set or status incorrect');
    }
  } catch (error) {
    log(`  FAIL: ${error.message}`, 'red');
    failed++;
  }

  // Test 5: Safety guard - reject auto-send
  try {
    log('\nTest 5: SAFETY: farcaster.dm-send blocks auto-send', 'yellow');
    try {
      await communitycrm['farcaster.dm-send']({
        input: {
          recipientFid: 'fid-123',
          message: 'This should not send',
          draftOnly: false,
        },
        state: {},
        executionMode: 'mock',
        signal: new MockAbortSignal(),
      });
      throw new Error('Should have blocked auto-send');
    } catch (innerError) {
      if (innerError.message.includes('SAFETY')) {
        log('  PASS: Auto-send correctly rejected', 'green');
        log(`    - Reason: ${innerError.message}`);
        passed++;
      } else {
        throw innerError;
      }
    }
  } catch (error) {
    log(`  FAIL: ${error.message}`, 'red');
    failed++;
  }

  // Test 6: Approval gate for bulk sends
  try {
    log('\nTest 6: farcaster.dm-send (approval gate for bulk sends)', 'yellow');
    const result = await communitycrm['farcaster.dm-send']({
      input: {
        recipientFid: 'fid-123',
        message: 'Bulk DM message',
        draftOnly: true,
        requireApprovalIfBulk: true,
        maxPerBatch: 25,
      },
      state: {},
      executionMode: 'mock',
      signal: new MockAbortSignal(),
    });

    if (result.success && result.requiresApproval) {
      log('  PASS: Bulk DM send correctly staged for approval', 'green');
      log(`    - Status: ${result.status}`);
      log(`    - Requires Approval: ${result.requiresApproval}`);
      passed++;
    } else {
      throw new Error('Approval gate not enforced');
    }
  } catch (error) {
    log(`  FAIL: ${error.message}`, 'red');
    failed++;
  }

  // Test 7: Update relationship status
  try {
    log('\nTest 7: circle.relationship-status-write (immutable log)', 'yellow');
    const result = await communitycrm['circle.relationship-status-write']({
      input: {
        memberId: 'test-member-001',
        updateType: 'stage-updated',
      },
      state: {},
      executionMode: 'mock',
    });

    if (result.success && result.immutableLog) {
      log('  PASS: Relationship status updated (immutable)', 'green');
      log(`    - Member: ${result.memberId}`);
      log(`    - Update Type: ${result.updateType}`);
      passed++;
    } else {
      throw new Error('Update not persisted');
    }
  } catch (error) {
    log(`  FAIL: ${error.message}`, 'red');
    failed++;
  }

  // Test 8: Safety guard - reject secrets in state
  try {
    log('\nTest 8: SAFETY: circle.relationship-status-write blocks secrets', 'yellow');
    try {
      await communitycrm['circle.relationship-status-write']({
        input: {
          memberId: 'test-member-001',
          updateType: 'stage-updated',
          secret: '0xabcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789',
        },
        state: {},
        executionMode: 'live',
      });
      throw new Error('Should have blocked secret');
    } catch (innerError) {
      if (innerError.message.includes('SECURITY')) {
        log('  PASS: Secret correctly rejected', 'green');
        log(`    - Reason: ${innerError.message}`);
        passed++;
      } else {
        throw innerError;
      }
    }
  } catch (error) {
    log(`  FAIL: ${error.message}`, 'red');
    failed++;
  }

  // Test 9: Log relationship events
  try {
    log('\nTest 9: log.relationship-events-write (immutable)', 'yellow');
    const result = await communitycrm['log.relationship-events-write']({
      input: {
        eventType: 'relationship-state-change',
        includeTimestamp: true,
      },
      state: {},
      executionMode: 'mock',
    });

    if (result.success && result.logged) {
      log('  PASS: Relationship event logged', 'green');
      log(`    - Event Type: ${result.eventType}`);
      log(`    - Timestamp: ${result.timestamp}`);
      passed++;
    } else {
      throw new Error('Event not logged');
    }
  } catch (error) {
    log(`  FAIL: ${error.message}`, 'red');
    failed++;
  }

  // Test 10: Read Farcaster activity
  try {
    log('\nTest 10: farcaster.activity-read', 'yellow');
    const result = await communitycrm['farcaster.activity-read']({
      input: {
        maxRecent: 50,
        includeProjectData: true,
      },
      state: {},
      signal: new MockAbortSignal(),
    });

    if (result.success && result.activities) {
      log('  PASS: Successfully read member activity', 'green');
      log(`    - Activities found: ${result.activityCount}`);
      log(`    - Max Recent: ${result.maxRecent}`);
      passed++;
    } else {
      throw new Error('Activity data missing');
    }
  } catch (error) {
    log(`  FAIL: ${error.message}`, 'red');
    failed++;
  }

  // Test 11: Fetch cowork projects
  try {
    log('\nTest 11: cowork.fetch-projects', 'yellow');
    const result = await communitycrm['cowork.fetch-projects']({
      input: {
        fetchMemberProjects: true,
      },
      state: {},
      signal: new MockAbortSignal(),
    });

    if (result.success && result.projects) {
      log('  PASS: Successfully fetched member projects', 'green');
      log(`    - Projects found: ${result.projectCount}`);
      log(`    - Sample: ${result.projects[0]?.name || 'None'}`);
      passed++;
    } else {
      throw new Error('Project data missing');
    }
  } catch (error) {
    log(`  FAIL: ${error.message}`, 'red');
    failed++;
  }

  // Test 12: Verify relationship stages
  try {
    log('\nTest 12: RELATIONSHIP_STAGES constant', 'yellow');
    const stages = ['discover', 'engage', 'coordinate', 'escalate', 'nurture'];
    let allValid = true;

    for (const stage of stages) {
      if (!RELATIONSHIP_STAGES[stage]) {
        allValid = false;
        log(`    - Missing: ${stage}`, 'red');
      }
    }

    if (allValid) {
      log('  PASS: All lifecycle stages defined', 'green');
      for (const [stage, config] of Object.entries(RELATIONSHIP_STAGES)) {
        log(`    - ${stage}: ${config.action} (auto: ${config.autoSend})`);
      }
      passed++;
    } else {
      throw new Error('Missing stages');
    }
  } catch (error) {
    log(`  FAIL: ${error.message}`, 'red');
    failed++;
  }

  // Summary
  log('\n=== Dry Run Summary ===\n', 'blue');
  log(`Total Tests: ${passed + failed}`);
  log(`Passed: ${passed}`, 'green');
  log(`Failed: ${failed}`, failed > 0 ? 'red' : 'green');

  if (failed === 0) {
    log('\nAll tests passed! Loop is safe to integrate.', 'green');
    process.exit(0);
  } else {
    log('\nSome tests failed. Review above.', 'red');
    process.exit(1);
  }
}

// Run the dry-run
runDryRun().catch((error) => {
  log(`FATAL: ${error.message}`, 'red');
  process.exit(1);
});
