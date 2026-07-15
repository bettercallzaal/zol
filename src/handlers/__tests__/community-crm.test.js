// src/handlers/__tests__/community-crm.test.js - Tests for community CRM handlers
// Test handlers in isolation, verify safety guards, check state mutations

const test = require('node:test');
const assert = require('node:assert');
const { communitycrm, RELATIONSHIP_STAGES } = require('../community-crm');

test('community-crm handlers', async (t) => {
  // Test: relationship status read
  await t.test('circle.relationship-status-read returns member data', async () => {
    const result = await communitycrm['circle.relationship-status-read']({
      input: { memberId: 'member-123' },
      state: {},
      signal: null,
    });

    assert.strictEqual(result.success, true);
    assert(result.relationship);
    assert.strictEqual(result.relationship.memberId, 'member-123');
    assert(result.relationship.stage);
    assert(result.relationship.history);
  });

  // Test: relationship status write (immutable log)
  await t.test('circle.relationship-status-write persists update', async () => {
    const result = await communitycrm['circle.relationship-status-write']({
      input: { memberId: 'member-123', updateType: 'stage-updated' },
      state: {},
      executionMode: 'mock',
    });

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.updateType, 'stage-updated');
    assert.strictEqual(result.immutableLog, true);
  });

  // Test: relationship status write rejects secrets
  await t.test('circle.relationship-status-write blocks secret patterns', async () => {
    const secretInput = {
      memberId: 'member-123',
      updateType: 'stage-updated',
      secret: '0x1234567890abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    };

    try {
      await communitycrm['circle.relationship-status-write']({
        input: secretInput,
        state: {},
        executionMode: 'live',
      });
      assert.fail('Should have thrown on secret pattern');
    } catch (error) {
      assert(error.message.includes('SECURITY'));
    }
  });

  // Test: message classification
  await t.test('message.classify returns classifications', async () => {
    const result = await communitycrm['message.classify']({
      input: {
        types: ['welcome', 'invite', 'project-suggestion'],
        contextKey: 'relationship-lifecycle-stages',
      },
      state: {},
      signal: null,
    });

    assert.strictEqual(result.success, true);
    assert(result.classifications);
    assert('welcome' in result.classifications);
  });

  // Test: priority plan for relationship action
  await t.test('priority.plan proposes relationship action', async () => {
    const result = await communitycrm['priority.plan']({
      input: {
        scope: 'relationship-lifecycle-action',
        stageAware: true,
      },
      state: {},
      signal: null,
    });

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.scope, 'relationship-lifecycle-action');
    assert(result.actionProposed);
  });

  // Test: priority plan for approval decision
  await t.test('priority.plan decides on approval gate', async () => {
    const result = await communitycrm['priority.plan']({
      input: {
        scope: 'approval-decision',
        gateType: 'bulk-send',
        threshold: 10,
      },
      state: {},
      signal: null,
    });

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.scope, 'approval-decision');
    assert.strictEqual(result.requiresApproval, true);
  });

  // Test: DM send is draft-only
  await t.test('farcaster.dm-send is draft-only (never auto-send)', async () => {
    const result = await communitycrm['farcaster.dm-send']({
      input: {
        recipientFid: 'fid-123',
        message: 'Hello!',
        draftOnly: true,
      },
      state: {},
      executionMode: 'mock',
      signal: null,
    });

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.draftOnly, true);
    assert(result.status.includes('draft'));
  });

  // Test: DM send fails if not draft-only
  await t.test('farcaster.dm-send blocks auto-send (safety check)', async () => {
    try {
      await communitycrm['farcaster.dm-send']({
        input: {
          recipientFid: 'fid-123',
          message: 'Hello!',
          draftOnly: false,
        },
        state: {},
        executionMode: 'mock',
        signal: null,
      });
      assert.fail('Should have thrown on auto-send');
    } catch (error) {
      assert(error.message.includes('SAFETY'));
    }
  });

  // Test: DM send with approval gate
  await t.test('farcaster.dm-send enforces approval gate for bulk sends', async () => {
    const result = await communitycrm['farcaster.dm-send']({
      input: {
        recipientFid: 'fid-123',
        message: 'Hello!',
        draftOnly: true,
        requireApprovalIfBulk: true,
        maxPerBatch: 15,
      },
      state: {},
      executionMode: 'mock',
      signal: null,
    });

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.requiresApproval, true);
    assert(result.status.includes('approval'));
  });

  // Test: event logging
  await t.test('log.relationship-events-write records events', async () => {
    const result = await communitycrm['log.relationship-events-write']({
      input: {
        eventType: 'relationship-state-change',
        includeTimestamp: true,
      },
      state: {},
      executionMode: 'mock',
    });

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.eventType, 'relationship-state-change');
    assert.strictEqual(result.logged, true);
  });

  // Test: event logging blocks secrets
  await t.test('log.relationship-events-write blocks secret patterns', async () => {
    try {
      await communitycrm['log.relationship-events-write']({
        input: {
          eventType: 'test',
          secret: 'sk-1234567890abcdef1234567890abcdef',
        },
        state: {},
        executionMode: 'live',
      });
      assert.fail('Should have thrown on secret pattern');
    } catch (error) {
      assert(error.message.includes('SECURITY'));
    }
  });

  // Test: Farcaster activity read
  await t.test('farcaster.activity-read returns member activity', async () => {
    const result = await communitycrm['farcaster.activity-read']({
      input: {
        maxRecent: 50,
        includeProjectData: true,
      },
      state: {},
      signal: null,
    });

    assert.strictEqual(result.success, true);
    assert(result.activities);
    assert(Array.isArray(result.activities));
  });

  // Test: cowork projects fetch
  await t.test('cowork.fetch-projects returns member projects', async () => {
    const result = await communitycrm['cowork.fetch-projects']({
      input: {
        fetchMemberProjects: true,
      },
      state: {},
      signal: null,
    });

    assert.strictEqual(result.success, true);
    assert(result.projects);
    assert(Array.isArray(result.projects));
  });

  // Test: RELATIONSHIP_STAGES constant
  await t.test('RELATIONSHIP_STAGES defines all lifecycle stages', () => {
    assert(RELATIONSHIP_STAGES.discover);
    assert(RELATIONSHIP_STAGES.engage);
    assert(RELATIONSHIP_STAGES.coordinate);
    assert(RELATIONSHIP_STAGES.escalate);
    assert(RELATIONSHIP_STAGES.nurture);

    // Verify each stage has required fields
    for (const [stage, config] of Object.entries(RELATIONSHIP_STAGES)) {
      assert(config.criteria, `${stage} missing criteria`);
      assert(config.action, `${stage} missing action`);
      assert('autoSend' in config, `${stage} missing autoSend`);
    }
  });

  // Test: Input validation
  await t.test('handlers validate required inputs', async () => {
    try {
      await communitycrm['circle.relationship-status-read']({
        input: {},
        state: {},
        signal: null,
      });
      assert.fail('Should have thrown on missing memberId');
    } catch (error) {
      assert(error.message.includes('required'));
    }
  });

  // Test: Input type validation
  await t.test('handlers validate input types', async () => {
    try {
      await communitycrm['circle.relationship-status-read']({
        input: { memberId: 123 },
        state: {},
        signal: null,
      });
      assert.fail('Should have thrown on wrong type');
    } catch (error) {
      assert(error.message.includes('invalid type'));
    }
  });
});
