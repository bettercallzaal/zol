// Regression tests for the wins-spotter source selection.
//
// The bug: both arms of the source ternary returned MOCK_EPISODES, so the
// ACTIVE community-wins-spotlight-v1 loop (daily 06:30) drafted a celebration
// cast about the same two invented wins every morning and asked Zaal to approve
// posting them.

const test = require('node:test');
const assert = require('node:assert');
const { handlers } = require('../wins-spotter');

test('mock mode is now opt-in, and says so', async () => {
  const r = await handlers['community.wins.spot']({
    input: {},
    state: { executionMode: 'mock' },
  });
  assert.equal(r.source, 'mock');
  assert.ok(r.winsFound > 0, 'explicit mock mode should still produce wins');
});

test('supplied episodes win over everything and are labelled input', async () => {
  const r = await handlers['community.wins.spot']({
    input: {
      episodes: [
        { name: 'zaal-note', content: 'Shipped the grill position fix.', created_at: new Date().toISOString() },
      ],
    },
    state: {},
  });
  assert.equal(r.source, 'input');
});

// THE BUG. Without an explicit mock mode and with no board reachable, the old
// code fell through to MOCK_EPISODES and reported wins that never happened.
test('no mock mode and no board means ZERO wins, not invented ones', async () => {
  const r = await handlers['community.wins.spot']({ input: {}, state: {} });
  assert.equal(r.source, 'cowork-board-empty');
  assert.equal(r.winsFound, 0, 'a quiet morning must be quiet, not fabricated');
  assert.deepEqual(r.wins, []);
  const text = JSON.stringify(r);
  assert.ok(!text.includes('WaveWarZ v2 on mainnet'), 'must not leak the mock win');
  assert.ok(!text.includes('COC Concertz #7'), 'must not leak the mock win');
});

test('the lying bonfireMode field is gone', async () => {
  process.env.BONFIRE_API_KEY = 'set-but-irrelevant';
  const r = await handlers['community.wins.spot']({ input: {}, state: {} });
  assert.equal(r.bonfireMode, undefined, 'bonfireMode reported availability while serving mocks');
  assert.ok(typeof r.source === 'string' && r.source.length > 0, 'source names what was actually read');
  delete process.env.BONFIRE_API_KEY;
});
