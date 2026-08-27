// src/handlers/__tests__/weekly-curator.test.js - Tests for weekly curator handlers
// Test handlers in isolation, verify safety guards, check state mutations and week carryover

const test = require('node:test');
const assert = require('node:assert');
const { weeklycurator, RECAP_STAGES } = require('../weekly-curator');

test('weekly-curator handlers', async (t) => {
  // Test: state read (initial state)
  await t.test('state.local.read returns empty summarized weeks initially', async () => {
    const result = await weeklycurator['state.local.read']({
      input: { key: 'weekly-curator-state' },
      state: {},
      signal: null,
    });

    assert.strictEqual(result.success, true);
    assert(result.state);
    assert(Array.isArray(result.state.summarizedWeeks));
  });

  // Test: state write (record week summarized)
  await t.test('state.local.write records week as summarized', async () => {
    const result = await weeklycurator['state.local.write']({
      input: {
        key: 'weekly-curator-state',
        updateType: 'week-summarized',
        immutableLog: true,
      },
      state: {},
      executionMode: 'mock',
    });

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.updateType, 'week-summarized');
    assert.strictEqual(result.immutableLog, true);
  });

  // Test: state write rejects secrets
  await t.test('state.local.write blocks secret patterns', async () => {
    const secretInput = {
      key: 'weekly-curator-state',
      updateType: 'week-summarized',
      secret: '0x1234567890abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    };

    try {
      await weeklycurator['state.local.write']({
        input: secretInput,
        state: {},
        executionMode: 'live',
      });
      assert.fail('Should have thrown on secret pattern');
    } catch (error) {
      assert(error.message.includes('SECURITY'));
    }
  });

  // Test: draft write is draft-only (enforces safety)
  await t.test('state.local.write enforces draft-only for weekly-curator-draft', async () => {
    try {
      await weeklycurator['state.local.write']({
        input: {
          key: 'weekly-curator-draft',
          draftOnly: false,
          kind: 'weekly-recap',
        },
        state: {},
        executionMode: 'mock',
      });
      assert.fail('Should have thrown on draftOnly=false');
    } catch (error) {
      assert(error.message.includes('SAFETY'));
    }
  });

  // Test: draft write stages for approval
  await t.test('state.local.write stages draft for approval', async () => {
    const result = await weeklycurator['state.local.write']({
      input: {
        key: 'weekly-curator-draft',
        draftOnly: true,
        kind: 'weekly-recap',
      },
      state: {},
      executionMode: 'mock',
    });

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.draftOnly, true);
    assert.strictEqual(result.status, 'staged-for-approval');
  });

  // Test: read recent casts (7-day window)
  await t.test('farcaster.activity-read returns recent casts', async () => {
    const result = await weeklycurator['farcaster.activity-read']({
      input: {
        source: 'recent-casts-file',
        timeWindowDays: 7,
      },
      state: {},
      signal: null,
    });

    assert.strictEqual(result.success, true);
    assert(result.casts);
    assert(Array.isArray(result.casts));
    assert(result.casts.length >= 5);
    // Check structure
    for (const cast of result.casts) {
      assert(cast.text);
      assert(cast.ts);
    }
  });

  // Test: recall Bonfire context
  await t.test('farcaster.activity-read recalls Bonfire context', async () => {
    const result = await weeklycurator['farcaster.activity-read']({
      input: {
        source: 'bonfire-recall',
        query: 'ZAO music curators, standout tracks, and artist wins this week',
      },
      state: {},
      signal: null,
    });

    assert.strictEqual(result.success, true);
    assert(result.context);
    assert(typeof result.context === 'string');
    assert(result.context.length > 0);
  });

  // Test: classify and select highlight
  await t.test('message.classify selects best find of week', async () => {
    const result = await weeklycurator['message.classify']({
      input: {
        types: ['best-find-of-week', 'artist-spotlight', 'track-recommendation'],
        contextKey: 'weekly-curator-highlight',
      },
      state: {},
      signal: null,
    });

    assert.strictEqual(result.success, true);
    assert(result.classifications);
    assert(result.classifications['best-find-of-week']);
    assert(result.classifications['best-find-of-week'].selected);
    assert(typeof result.classifications['best-find-of-week'].score === 'number');
  });

  // Test: check similarity (draft not too similar to previous recaps)
  await t.test('message.classify checks similarity to previous recaps', async () => {
    const result = await weeklycurator['message.classify']({
      input: {
        types: ['duplicate-check'],
        contextKey: 'weekly-recap-similarity',
      },
      state: {},
      signal: null,
    });

    assert.strictEqual(result.success, true);
    assert(typeof result.isSimilar === 'boolean');
    assert(typeof result.similarityScore === 'number');
  });

  // Test: plan weekly recap check (can proceed if week not yet summarized)
  await t.test('priority.plan checks if week already summarized', async () => {
    const result = await weeklycurator['priority.plan']({
      input: {
        scope: 'weekly-recap-check',
        checkForDuplicateWeek: true,
      },
      state: { summarizedWeeks: [] },  // Fresh state, no weeks summarized yet
      signal: null,
    });

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.canProceed, true);
  });

  // Test: plan recap composition
  await t.test('priority.plan composes draft text', async () => {
    const result = await weeklycurator['priority.plan']({
      input: {
        scope: 'weekly-recap-composition',
        draftOnly: true,
        maxLength: 280,
      },
      state: {},
      signal: null,
    });

    assert.strictEqual(result.success, true);
    assert(result.draftText);
    assert.strictEqual(result.draftOnly, true);
    assert(result.textLength <= 280);
  });

  // Test: plan composition blocks auto-send
  await t.test('priority.plan blocks auto-send (safety check)', async () => {
    try {
      await weeklycurator['priority.plan']({
        input: {
          scope: 'weekly-recap-composition',
          draftOnly: false,
          maxLength: 280,
        },
        state: {},
        signal: null,
      });
      assert.fail('Should have thrown on draftOnly=false');
    } catch (error) {
      assert(error.message.includes('SAFETY'));
    }
  });

  // Test: event logging
  await t.test('log.zol-events-write records events', async () => {
    const result = await weeklycurator['log.zol-events-write']({
      input: {
        eventType: 'weekly-recap-drafted',
        includeResult: true,
      },
      state: {},
      executionMode: 'mock',
    });

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.eventType, 'weekly-recap-drafted');
    assert.strictEqual(result.logged, true);
  });

  // Test: event logging blocks secrets
  await t.test('log.zol-events-write blocks secret patterns', async () => {
    try {
      await weeklycurator['log.zol-events-write']({
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

  // Test: RECAP_STAGES constant
  await t.test('RECAP_STAGES defines all recap stages', () => {
    assert(RECAP_STAGES.collect);
    assert(RECAP_STAGES.contextualize);
    assert(RECAP_STAGES.highlight);
    assert(RECAP_STAGES.draft);
    assert(RECAP_STAGES.stage);

    // Verify each stage has required fields
    for (const [stage, config] of Object.entries(RECAP_STAGES)) {
      assert(config.description, `${stage} missing description`);
      assert(config.action, `${stage} missing action`);
    }
  });

  // Test: Input validation
  await t.test('handlers validate required inputs', async () => {
    try {
      await weeklycurator['priority.plan']({
        input: {},
        state: {},
        signal: null,
      });
      assert.fail('Should have thrown on missing scope');
    } catch (error) {
      assert(error.message.includes('required'));
    }
  });

  // Test: Input type validation
  await t.test('handlers validate input types', async () => {
    try {
      await weeklycurator['farcaster.activity-read']({
        input: { timeWindowDays: 'not-a-number' },
        state: {},
        signal: null,
      });
      assert.fail('Should have thrown on wrong type');
    } catch (error) {
      assert(error.message.includes('invalid type'));
    }
  });

  // Test: State carryover (week tracking prevents repeats)
  await t.test('state carryover prevents duplicate week summaries', async () => {
    const weekNumber = Math.floor(Date.now() / (7 * 24 * 60 * 60 * 1000));

    // First run: week not summarized yet
    const firstCheck = await weeklycurator['priority.plan']({
      input: {
        scope: 'weekly-recap-check',
        checkForDuplicateWeek: true,
      },
      state: { summarizedWeeks: [] },  // Fresh state
      signal: null,
    });

    assert.strictEqual(firstCheck.canProceed, true);

    // After recording the week... (simulate state-adapter persisting the week)
    const writeResult = await weeklycurator['state.local.write']({
      input: {
        key: 'weekly-curator-state',
        updateType: 'week-summarized',
      },
      state: { summarizedWeeks: [] },
      executionMode: 'mock',
    });

    assert.strictEqual(writeResult.success, true);
    assert.strictEqual(writeResult.weekNumber, weekNumber);

    // Second run: week is now marked (simulate state-adapter loading the week from storage)
    const secondCheck = await weeklycurator['priority.plan']({
      input: {
        scope: 'weekly-recap-check',
        checkForDuplicateWeek: true,
      },
      state: { summarizedWeeks: [weekNumber] },  // State-adapter loaded this from storage
      signal: null,
    });

    assert.strictEqual(secondCheck.success, true);
    assert.strictEqual(secondCheck.canProceed, false);  // Week already summarized, so don't proceed
  });

  // Test: Full success path (read casts -> select highlight -> compose -> stage draft)
  await t.test('full success path: read casts, select highlight, compose, stage draft', async () => {
    // Step 1: Read recent casts
    const castsResult = await weeklycurator['farcaster.activity-read']({
      input: {
        source: 'recent-casts-file',
        timeWindowDays: 7,
      },
      state: {},
      signal: null,
    });
    assert.strictEqual(castsResult.success, true);
    assert(castsResult.casts.length > 0);

    // Step 2: Select highlight
    const highlightResult = await weeklycurator['message.classify']({
      input: {
        types: ['best-find-of-week'],
        contextKey: 'weekly-curator-highlight',
      },
      state: {},
      signal: null,
    });
    assert.strictEqual(highlightResult.success, true);
    assert(highlightResult.classifications['best-find-of-week'].selected);

    // Step 3: Compose draft
    const draftResult = await weeklycurator['priority.plan']({
      input: {
        scope: 'weekly-recap-composition',
        draftOnly: true,
        maxLength: 280,
      },
      state: {},
      signal: null,
    });
    assert.strictEqual(draftResult.success, true);
    assert(draftResult.draftText);

    // Step 4: Stage draft
    const stageResult = await weeklycurator['state.local.write']({
      input: {
        key: 'weekly-curator-draft',
        draftOnly: true,
        kind: 'weekly-recap',
      },
      state: {},
      executionMode: 'mock',
    });
    assert.strictEqual(stageResult.success, true);
    assert.strictEqual(stageResult.status, 'staged-for-approval');
  });
});
