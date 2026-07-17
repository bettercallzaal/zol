// src/handlers/__tests__/stub-handlers.test.js - Tests for Phase 5 stub handlers
// Run: node --test src/handlers/__tests__/stub-handlers.test.js

const { describe, test } = require('node:test');
const assert = require('node:assert');
const handlers = require('../index');

// ===== REGISTRATION CHECKS =====
describe('stub handler registration', () => {
  // cowork.fetch-projects and model.completion wired to real implementations (capability-gap cycles 1-2)
  const stubNames = [
    'telegram.approval.request',
    'farcaster.activity-read',
    'cast.read',
    'cast.draft',
    'farcaster.recent-casts-parse',
    'farcaster.dm-send',
    'log.relationship-events-write',
    'log.zol-events-write',
    'checkpoint.local.write',
    'artifact.draft.write',
    'api.read.external',
    'bonfire.delve-recall',
    'toolgym.mastery.record',
    'toolgym.workout.run',
    'circle.relationship-status-read',
    'circle.relationship-status-write',
    'artist-spotlight.filter-eligible-artists',
    'artist-spotlight.select-one-artist',
    'artist-spotlight.compose-spotlight-draft',
    'artist-spotlight.stage-draft-for-approval',
    'artist-spotlight.record-spotlight-completion',
    'warper.assignment.accept',
    'warper.trapper.release',
    'warper.trapper.sync',
  ];

  test('all 24 remaining stub handlers are registered', () => {
    for (const name of stubNames) {
      assert.strictEqual(typeof handlers[name], 'function', `${name} must be registered`);
    }
  });

  test('receipt.local.query and cowork.fetch-projects are registered as wired handlers', () => {
    assert.strictEqual(typeof handlers['receipt.local.query'], 'function');
    assert.strictEqual(typeof handlers['cowork.fetch-projects'], 'function');
  });
});

// ===== SECURITY: DRAFT-ONLY ENFORCEMENT =====
describe('draft-only enforcement', () => {
  test('cast.draft never includes a posted=true field', async () => {
    const result = await handlers['cast.draft']({
      input: { text: 'Hello Farcaster' },
      state: {},
      signal: null
    });
    assert.ok(result.drafted === true);
    assert.ok(result.status === 'staged');
    assert.ok(!result.posted, 'cast.draft must not set posted:true');
  });

  test('farcaster.dm-send returns draft_only status', async () => {
    const result = await handlers['farcaster.dm-send']({
      input: { recipientFid: 123, message: 'test' },
      state: {},
      signal: null
    });
    assert.strictEqual(result.status, 'draft_only');
    assert.ok(!result.sent, 'farcaster.dm-send must not set sent:true');
  });

  test('artifact.draft.write returns draft status', async () => {
    const result = await handlers['artifact.draft.write']({
      input: { artifactType: 'brief' },
      state: {},
      signal: null
    });
    assert.strictEqual(result.status, 'draft');
    assert.ok(!result.published, 'artifact.draft.write must not set published:true');
  });

  test('artist-spotlight.compose-spotlight-draft returns draft status', async () => {
    const result = await handlers['artist-spotlight.compose-spotlight-draft']({
      input: { artist: 'Test Artist' },
      state: {},
      signal: null
    });
    assert.strictEqual(result.status, 'draft');
    assert.ok(result.drafted === true);
  });
});

// ===== FUNCTIONAL SMOKE TESTS =====
describe('telegram.approval.request', () => {
  test('returns pending request with telegram channel', async () => {
    const result = await handlers['telegram.approval.request']({
      input: { message: 'approve this?' },
      state: {},
      signal: null
    });
    assert.strictEqual(result.channel, 'telegram');
    assert.strictEqual(result.status, 'pending');
    assert.ok(result.timestamp);
  });
});

describe('farcaster.activity-read', () => {
  test('returns empty casts array stub', async () => {
    const result = await handlers['farcaster.activity-read']({
      input: { fid: 3338501 },
      state: {},
      signal: null
    });
    assert.ok(Array.isArray(result.casts));
    assert.ok(result.timestamp);
  });
});

describe('cast.read', () => {
  test('returns empty casts array stub', async () => {
    const result = await handlers['cast.read']({
      input: { fid: 3338501, channel: 'zol' },
      state: {},
      signal: null
    });
    assert.ok(Array.isArray(result.casts));
    assert.ok(result.timestamp);
  });
});

describe('model.completion', () => {
  test('returns completed:true with non-empty text from wired ModelGateway (mock provider)', async () => {
    const result = await handlers['model.completion']({
      input: { prompt: 'summarize this', tier: 'standard' },
      state: {},
      signal: null
    });
    assert.ok(result.completed === true);
    assert.strictEqual(typeof result.text, 'string');
    assert.ok(result.text.length > 0, 'mock provider must return non-empty text');
    assert.ok(result.timestamp);
    assert.ok(typeof result.provider === 'string', 'provider must be present');
  });

  test('tier:cheap echoed back in result', async () => {
    const result = await handlers['model.completion']({
      input: { prompt: 'classify: music cast?', tier: 'cheap' },
      state: {},
      signal: null
    });
    assert.ok(result.completed === true);
    assert.strictEqual(result.tier, 'cheap');
    assert.ok(typeof result.text === 'string');
  });
});

describe('checkpoint.local.write', () => {
  test('returns written checkpoint with id', async () => {
    const result = await handlers['checkpoint.local.write']({
      input: { checkpointKey: 'step-3', workPacketId: 'wp_abc' },
      state: {},
      signal: null
    });
    assert.ok(result.written === true);
    assert.ok(typeof result.checkpointId === 'string');
    assert.ok(result.timestamp);
  });
});

describe('log.relationship-events-write', () => {
  test('returns logged:true', async () => {
    const result = await handlers['log.relationship-events-write']({
      input: { eventType: 'first-reply', fid: 123 },
      state: {},
      signal: null
    });
    assert.ok(result.logged === true);
    assert.ok(result.timestamp);
  });
});

describe('log.zol-events-write', () => {
  test('returns logged:true', async () => {
    const result = await handlers['log.zol-events-write']({
      input: { event: 'loop.completed', context: 'heartbeat-v1' },
      state: {},
      signal: null
    });
    assert.ok(result.logged === true);
    assert.ok(result.timestamp);
  });
});

describe('bonfire.delve-recall', () => {
  test('returns recalled:false with pending reason', async () => {
    const result = await handlers['bonfire.delve-recall']({
      input: { query: 'artist context', scope: 'spotlight' },
      state: {},
      signal: null
    });
    assert.strictEqual(result.recalled, false);
    assert.ok(result.reason.includes('pending'));
    assert.ok(Array.isArray(result.results));
  });
});

describe('api.read.external', () => {
  test('returns stub read with url', async () => {
    const result = await handlers['api.read.external']({
      input: { url: 'https://example.com/api', scope: 'zabal-submissions' },
      state: {},
      signal: null
    });
    assert.ok(result.read === true);
    assert.ok(result.timestamp);
  });
});

describe('circle.relationship-status-read', () => {
  test('returns found:false stub', async () => {
    const result = await handlers['circle.relationship-status-read']({
      input: { fid: 456, scope: 'warm' },
      state: {},
      signal: null
    });
    assert.strictEqual(result.found, false);
    assert.ok(result.timestamp);
  });
});

describe('circle.relationship-status-write', () => {
  test('returns written:true', async () => {
    const result = await handlers['circle.relationship-status-write']({
      input: { fid: 456, status: 'warm', note: 'met at fractal' },
      state: {},
      signal: null
    });
    assert.ok(result.written === true);
    assert.ok(result.timestamp);
  });
});

describe('artist-spotlight step handlers', () => {
  test('filter-eligible-artists returns eligible array', async () => {
    const result = await handlers['artist-spotlight.filter-eligible-artists']({
      input: { cooldownDays: 60 },
      state: {},
      signal: null
    });
    assert.ok(Array.isArray(result.eligible));
    assert.strictEqual(result.cooldownDays, 60);
  });

  test('select-one-artist returns selected:null stub', async () => {
    const result = await handlers['artist-spotlight.select-one-artist']({
      input: { strategy: 'rotation' },
      state: {},
      signal: null
    });
    assert.strictEqual(result.strategy, 'rotation');
    assert.ok(result.timestamp);
  });

  test('stage-draft-for-approval returns pending_approval status', async () => {
    const result = await handlers['artist-spotlight.stage-draft-for-approval']({
      input: { draftId: 'spot_abc123', channel: 'telegram' },
      state: {},
      signal: null
    });
    assert.ok(result.staged === true);
    assert.strictEqual(result.status, 'pending_approval');
  });

  test('record-spotlight-completion returns recorded:true', async () => {
    const result = await handlers['artist-spotlight.record-spotlight-completion']({
      input: { artist: 'Test Artist', draftId: 'spot_abc123' },
      state: {},
      signal: null
    });
    assert.ok(result.recorded === true);
    assert.ok(result.timestamp);
  });
});

describe('warper alias stubs', () => {
  test('warper.assignment.accept returns ok or disabled', async () => {
    const result = await handlers['warper.assignment.accept']({
      input: { scope: 'zol-work' },
      signal: null
    });
    assert.ok('ok' in result);
    assert.ok(result.timestamp);
  });

  test('warper.trapper.release returns ok or disabled', async () => {
    const result = await handlers['warper.trapper.release']({
      input: { reason: 'done' },
      signal: null
    });
    assert.ok('ok' in result);
    assert.ok(result.timestamp);
  });

  test('warper.trapper.sync returns ok or disabled', async () => {
    const result = await handlers['warper.trapper.sync']({
      input: {},
      signal: null
    });
    assert.ok('ok' in result);
    assert.ok(result.timestamp);
  });
});

describe('toolgym stubs', () => {
  test('toolgym.mastery.record returns recorded:true', async () => {
    const result = await handlers['toolgym.mastery.record']({
      input: { tool: 'farcaster.read', score: 80 },
      state: {},
      signal: null
    });
    assert.ok(result.recorded === true);
    assert.ok(result.timestamp);
  });

  test('toolgym.workout.run returns completed:true', async () => {
    const result = await handlers['toolgym.workout.run']({
      input: { workout: 'read-cast', tool: 'farcaster.read' },
      state: {},
      signal: null
    });
    assert.ok(result.completed === true);
    assert.ok(result.timestamp);
  });
});

describe('cowork.fetch-projects', () => {
  test('returns projects array (empty when COWORK_TRACKER_URL not configured)', async () => {
    const result = await handlers['cowork.fetch-projects']({
      input: { project: 'zaodevz' },
      state: {},
      signal: null
    });
    assert.ok(Array.isArray(result.projects), 'projects must be array');
    assert.strictEqual(result.count, 0, 'count must be 0 without tracker URL');
    assert.ok(result.timestamp);
  });
});

describe('receipt.local.query', () => {
  test('returns {receipts: [], count: 0} in mock/test context (no live state store)', async () => {
    const result = await handlers['receipt.local.query']({
      input: { limit: 10 },
      state: {},
      signal: null
    });
    assert.ok(Array.isArray(result.receipts), 'receipts must be array');
    assert.ok(typeof result.count === 'number', 'count must be number');
    assert.ok(result.timestamp);
  });

  test('accepts loopId filter without throwing', async () => {
    const result = await handlers['receipt.local.query']({
      input: { loopId: 'heartbeat', limit: 5 },
      state: {},
      signal: null
    });
    assert.ok(Array.isArray(result.receipts));
    assert.ok(typeof result.count === 'number');
  });
});
