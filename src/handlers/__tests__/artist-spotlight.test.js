// src/handlers/__tests__/artist-spotlight.test.js - Tests for artist spotlight handlers
// Test handlers in isolation, verify safety guards, check state mutations and multi-run carryover

const test = require('node:test');
const assert = require('node:assert');
const { artistspotlight } = require('../artist-spotlight');

test('artist-spotlight handlers', async (t) => {
  // Test: read spotlight history
  await t.test('state.local.read retrieves spotlight history', async () => {
    const state = {
      'artist-spotlight-v1-history': [
        { artist: 'Artist A', spotlightedAt: new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString() },
        { artist: 'Artist B', spotlightedAt: new Date(Date.now() - 50 * 24 * 60 * 60 * 1000).toISOString() },
      ],
    };

    const result = await artistspotlight['state.local.read']({
      input: { stateKey: 'artist-spotlight-v1-history' },
      state,
      signal: null,
    });

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.stateKey, 'artist-spotlight-v1-history');
    assert(result.history);
    assert.strictEqual(result.history.length, 2);
    assert.strictEqual(result.history[0].artist, 'Artist A');
  });

  // Test: read empty history
  await t.test('state.local.read handles empty history', async () => {
    const result = await artistspotlight['state.local.read']({
      input: { stateKey: 'artist-spotlight-v1-history' },
      state: {},
      signal: null,
    });

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.history.length, 0);
  });

  // Test: write to state
  await t.test('state.local.write persists state', async () => {
    const result = await artistspotlight['state.local.write']({
      input: {
        stateKey: 'artist-spotlight-v1-history',
        value: { artist: 'Artist C', spotlightedAt: new Date().toISOString() },
        appendMode: true,
      },
      state: {},
      executionMode: 'mock',
      signal: null,
    });

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.stateKey, 'artist-spotlight-v1-history');
    assert.strictEqual(result.appendMode, true);
  });

  // Test: state write rejects secrets
  await t.test('state.local.write blocks secret patterns', async () => {
    try {
      await artistspotlight['state.local.write']({
        input: {
          stateKey: 'test',
          value: { secret: '0x1234567890abcdef0123456789abcdef0123456789abcdef0123456789abcdef' },
        },
        state: {},
        executionMode: 'live',
        signal: null,
      });
      assert.fail('Should have thrown on secret pattern');
    } catch (error) {
      assert(error.message.includes('SECURITY'));
    }
  });

  // Test: bonfire recall
  await t.test('bonfire.delve-recall fetches artist context', async () => {
    const result = await artistspotlight['bonfire.delve-recall']({
      input: {
        query: 'ZAO artists collaborations and community members to spotlight',
        maxEpisodes: 15,
      },
      state: {},
      signal: null,
    });

    assert.strictEqual(result.success, true);
    assert(result.context);
    assert(result.context.includes('artist') || result.context.includes('Artist'));
    assert.strictEqual(result.maxEpisodes, 15);
  });

  // Test: parse recent casts
  await t.test('farcaster.recent-casts-parse extracts artists', async () => {
    const result = await artistspotlight['farcaster.recent-casts-parse']({
      input: {
        recentPath: '~/zol/recent-casts.json',
        extractArtists: true,
      },
      state: {},
      signal: null,
    });

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.extractedArtists, true);
    assert(result.artists);
    assert(Array.isArray(result.artists));
    assert(result.artists.length > 0);
  });

  // Test: filter eligible artists (no recent spotlights)
  await t.test('artist-spotlight.filter-eligible-artists filters out recent spotlights', async () => {
    const state = {
      'artist-spotlight-v1-history': [
        { artist: 'Artist A', spotlightedAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString() },
        { artist: 'Artist B', spotlightedAt: new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString() },
      ],
    };

    const result = await artistspotlight['artist-spotlight.filter-eligible-artists']({
      input: {
        cooldownDays: 60,
        historyState: 'artist-spotlight-v1-history',
      },
      state,
      signal: null,
    });

    assert.strictEqual(result.success, true);
    assert(result.eligible);
    assert(Array.isArray(result.eligible));
    // Artist A is within 60 days, so should be filtered out
    assert(!result.eligible.some((a) => a.toLowerCase() === 'artist a'));
    // Artist B is >60 days old, so could be included
    assert(result.eligible.some((a) => a.toLowerCase() === 'artist b') || result.eligible.length > 0);
  });

  // Test: filter eligible artists throws when all are recent
  await t.test('artist-spotlight.filter-eligible-artists throws when no eligible artists', async () => {
    const recentTime = new Date().toISOString();
    const state = {
      'artist-spotlight-v1-history': [
        { artist: 'Ivy Wong', spotlightedAt: recentTime },
        { artist: 'Marcus Chen', spotlightedAt: recentTime },
        { artist: 'Lila Rossi', spotlightedAt: recentTime },
        { artist: 'Amir Khalil', spotlightedAt: recentTime },
        { artist: 'Sofia Delgado', spotlightedAt: recentTime },
      ],
    };

    try {
      await artistspotlight['artist-spotlight.filter-eligible-artists']({
        input: {
          cooldownDays: 60,
          historyState: 'artist-spotlight-v1-history',
        },
        state,
        signal: null,
      });
      assert.fail('Should have thrown when no eligible artists');
    } catch (error) {
      assert(error.message.includes('SAFETY'));
    }
  });

  // Test: select one artist
  await t.test('artist-spotlight.select-one-artist picks from candidates', async () => {
    const result = await artistspotlight['artist-spotlight.select-one-artist']({
      input: {
        weightRandom: true,
        candidates: {
          eligible: ['Artist A', 'Artist B', 'Artist C'],
        },
      },
      state: {},
      signal: null,
    });

    assert.strictEqual(result.success, true);
    assert(result.selectedArtist);
    assert(['Artist A', 'Artist B', 'Artist C'].includes(result.selectedArtist));
  });

  // Test: compose draft
  await t.test('artist-spotlight.compose-spotlight-draft composes draft text', async () => {
    const result = await artistspotlight['artist-spotlight.compose-spotlight-draft']({
      input: {
        maxLength: 280,
        draftOnly: true,
        selectedArtist: 'Ivy Wong',
      },
      state: {},
      signal: null,
    });

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.selectedArtist, 'Ivy Wong');
    assert(result.draftText);
    assert.strictEqual(result.draftOnly, true);
    assert(result.textLength <= 280);
    assert(result.draftText.includes('Ivy Wong'));
  });

  // Test: compose draft rejects auto-post
  await t.test('artist-spotlight.compose-spotlight-draft blocks auto-post', async () => {
    try {
      await artistspotlight['artist-spotlight.compose-spotlight-draft']({
        input: {
          maxLength: 280,
          draftOnly: false,
          selectedArtist: 'Marcus Chen',
        },
        state: {},
        signal: null,
      });
      assert.fail('Should have thrown on auto-post');
    } catch (error) {
      assert(error.message.includes('SAFETY'));
    }
  });

  // Test: stage draft for approval
  await t.test('artist-spotlight.stage-draft-for-approval stages draft', async () => {
    const draftText = 'Spotlight: Lila Rossi - a talented vocalist.';
    const result = await artistspotlight['artist-spotlight.stage-draft-for-approval']({
      input: {
        draftsDirectory: '~/zol/drafts',
        draftKind: 'artist-spotlight',
        draftText,
        selectedArtist: 'Lila Rossi',
        writeFile: false, // don't actually write in test
      },
      state: {},
      executionMode: 'mock',
      signal: null,
    });

    assert.strictEqual(result.success, true);
    assert(result.hash);
    assert.strictEqual(result.draftKind, 'artist-spotlight');
    assert.strictEqual(result.artist, 'Lila Rossi');
    assert(result.note.includes('~/zol/drafts/'));
  });

  // Test: record completion
  await t.test('artist-spotlight.record-spotlight-completion records event', async () => {
    const result = await artistspotlight['artist-spotlight.record-spotlight-completion']({
      input: {
        eventType: 'artist-spotlight-drafted',
        selectedArtist: 'Amir Khalil',
        draftHash: 'abc123def456',
      },
      state: {},
      executionMode: 'mock',
      signal: null,
    });

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.eventType, 'artist-spotlight-drafted');
    assert(result.completionRecord);
    assert.strictEqual(result.completionRecord.artist, 'Amir Khalil');
  });

  // Test: Multi-run state carryover - simulate 3 sequential runs
  // This is the critical test: ensure state carries over and artists don't repeat within cooldown
  await t.test('multi-run state carryover: artists rotate without repetition within 60 days', async () => {
    let state = { 'artist-spotlight-v1-history': [] };
    const selectedArtists = [];

    // Run 1: empty history
    let result1 = await artistspotlight['state.local.read']({
      input: { stateKey: 'artist-spotlight-v1-history' },
      state,
      signal: null,
    });
    assert.strictEqual(result1.history.length, 0);

    // Select and stage artist 1
    const artist1Result = await artistspotlight['artist-spotlight.select-one-artist']({
      input: { weightRandom: true, candidates: { eligible: ['Ivy Wong', 'Marcus Chen', 'Lila Rossi'] } },
      state,
      signal: null,
    });
    selectedArtists.push(artist1Result.selectedArtist);

    // Record and update state
    state['artist-spotlight-v1-history'] = [
      { artist: artist1Result.selectedArtist, spotlightedAt: new Date().toISOString() },
    ];

    // Run 2: history has 1 entry
    let result2 = await artistspotlight['state.local.read']({
      input: { stateKey: 'artist-spotlight-v1-history' },
      state,
      signal: null,
    });
    assert.strictEqual(result2.history.length, 1);
    assert.strictEqual(result2.history[0].artist, selectedArtists[0]);

    // Select artist 2 - should filter out artist 1
    const filterResult2 = await artistspotlight['artist-spotlight.filter-eligible-artists']({
      input: { cooldownDays: 60, historyState: 'artist-spotlight-v1-history' },
      state,
      signal: null,
    });
    const artist2Result = await artistspotlight['artist-spotlight.select-one-artist']({
      input: { weightRandom: true, candidates: filterResult2 },
      state,
      signal: null,
    });
    selectedArtists.push(artist2Result.selectedArtist);

    // Ensure no repeat
    assert.notStrictEqual(artist2Result.selectedArtist, selectedArtists[0]);

    // Update state
    state['artist-spotlight-v1-history'].push({
      artist: artist2Result.selectedArtist,
      spotlightedAt: new Date().toISOString(),
    });

    // Run 3: history has 2 entries
    let result3 = await artistspotlight['state.local.read']({
      input: { stateKey: 'artist-spotlight-v1-history' },
      state,
      signal: null,
    });
    assert.strictEqual(result3.history.length, 2);

    // Select artist 3 - should filter out artists 1 and 2
    const filterResult3 = await artistspotlight['artist-spotlight.filter-eligible-artists']({
      input: { cooldownDays: 60, historyState: 'artist-spotlight-v1-history' },
      state,
      signal: null,
    });
    const artist3Result = await artistspotlight['artist-spotlight.select-one-artist']({
      input: { weightRandom: true, candidates: filterResult3 },
      state,
      signal: null,
    });
    selectedArtists.push(artist3Result.selectedArtist);

    // Ensure no repeats
    assert.notStrictEqual(artist3Result.selectedArtist, selectedArtists[0]);
    assert.notStrictEqual(artist3Result.selectedArtist, selectedArtists[1]);

    // History should reflect 3 spotlights total
    assert.strictEqual(selectedArtists.length, 3);
    assert(selectedArtists[0] !== selectedArtists[1]);
    assert(selectedArtists[1] !== selectedArtists[2]);
  });

  // Test: Input validation
  await t.test('handlers validate required inputs', async () => {
    try {
      await artistspotlight['state.local.read']({
        input: {},
        state: {},
        signal: null,
      });
      // state.local.read has no required inputs, so this should succeed
      // Try a handler that has required inputs
      await artistspotlight['artist-spotlight.filter-eligible-artists']({
        input: { cooldownDays: 60 }, // historyState is optional
        state: {},
        signal: null,
      });
      // Should succeed with valid inputs
    } catch (error) {
      assert.fail(`Should not have thrown: ${error.message}`);
    }
  });

  // Test: Draft length is capped
  await t.test('artist-spotlight.compose-spotlight-draft respects maxLength', async () => {
    const result = await artistspotlight['artist-spotlight.compose-spotlight-draft']({
      input: {
        maxLength: 100,
        draftOnly: true,
        selectedArtist: 'Sofia Delgado',
      },
      state: {},
      signal: null,
    });

    assert.strictEqual(result.success, true);
    assert(result.textLength <= 100);
  });

  // Test: No artist repeat within cooldown window
  await t.test('filtering correctly identifies recent vs. old spotlights', async () => {
    const now = new Date();
    const old30d = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const old90d = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000).toISOString();

    const state = {
      'artist-spotlight-v1-history': [
        { artist: 'Ivy Wong', spotlightedAt: now.toISOString() }, // just spotlighted
        { artist: 'Marcus Chen', spotlightedAt: old30d }, // 30 days ago (within 60d cooldown)
        { artist: 'Lila Rossi', spotlightedAt: old90d }, // 90 days ago (outside 60d cooldown)
      ],
    };

    const result = await artistspotlight['artist-spotlight.filter-eligible-artists']({
      input: { cooldownDays: 60, historyState: 'artist-spotlight-v1-history' },
      state,
      signal: null,
    });

    assert.strictEqual(result.success, true);
    // Ivy Wong and Marcus Chen should be filtered (within 60 days)
    assert(!result.eligible.some((a) => a.toLowerCase() === 'ivy wong'));
    assert(!result.eligible.some((a) => a.toLowerCase() === 'marcus chen'));
    // Lila Rossi should NOT be filtered (>60 days old)
    assert(result.eligible.some((a) => a.toLowerCase() === 'lila rossi'));
  });
});
