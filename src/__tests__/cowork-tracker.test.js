// src/__tests__/cowork-tracker.test.js
// Unit tests for CoworkTracker using a mock fetch (no real network calls).
// All board writes are fire-and-forget safe — errors return ok:false, never throw.

const test  = require('node:test');
const assert = require('node:assert');
const { CoworkTracker } = require('../cowork-tracker');

// Minimal fetch stub — returns JSON with status 200 by default.
function makeFetch(response = {}, status = 200) {
  return async (_url, _opts) => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(response),
  });
}

// ---- constructor / config --------------------------------------------------

test('CoworkTracker: missing config returns ok:false without throwing', async () => {
  const tracker = new CoworkTracker({ baseUrl: '', apiKey: '' });
  const result = await tracker.getById('any-id');
  assert.strictEqual(result.ok, false);
  assert.ok(result.error.includes('not configured'));
});

// ---- createTask ------------------------------------------------------------

test('CoworkTracker.createTask: sends POST and returns ok+id', async () => {
  const row = { id: 'abc-123', status: 'in_progress', title: 'Test task' };
  const tracker = new CoworkTracker({ baseUrl: 'https://example.supabase.co', apiKey: 'key' });
  tracker._req = async (method, path, body) => ({ ok: true, data: [row] });

  const result = await tracker.createTask('Test task', { priority: 'P1' });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.id, 'abc-123');
  assert.deepStrictEqual(result.row, row);
});

test('CoworkTracker.createTask: API error returns ok:false', async () => {
  const tracker = new CoworkTracker({ baseUrl: 'https://example.supabase.co', apiKey: 'key' });
  tracker._req = async () => ({ ok: false, error: 'HTTP 422: duplicate' });

  const result = await tracker.createTask('Dup task');
  assert.strictEqual(result.ok, false);
  assert.ok(result.error.includes('duplicate'));
});

// ---- startTask / finishTask / blockTask ------------------------------------

test('CoworkTracker.startTask: sends PATCH with status=in_progress', async () => {
  const tracker = new CoworkTracker({ baseUrl: 'https://example.supabase.co', apiKey: 'key' });
  let patchedBody;
  tracker._req = async (_m, _p, body) => { patchedBody = body; return { ok: true, data: [{}] }; };

  await tracker.startTask('task-id', 'Starting now');
  assert.strictEqual(patchedBody.status, 'in_progress');
  assert.strictEqual(patchedBody.notes, 'Starting now');
});

test('CoworkTracker.finishTask: sends PATCH with status=done and completed_at', async () => {
  const tracker = new CoworkTracker({ baseUrl: 'https://example.supabase.co', apiKey: 'key' });
  let patchedBody;
  tracker._req = async (_m, _p, body) => { patchedBody = body; return { ok: true, data: [{}] }; };

  await tracker.finishTask('task-id', 'PR #31: https://github.com/...');
  assert.strictEqual(patchedBody.status, 'done');
  assert.ok(patchedBody.notes.includes('PR #31'));
  assert.ok(patchedBody.completed_at, 'completed_at should be set');
});

test('CoworkTracker.blockTask: sends PATCH with status=blocked', async () => {
  const tracker = new CoworkTracker({ baseUrl: 'https://example.supabase.co', apiKey: 'key' });
  let patchedBody;
  tracker._req = async (_m, _p, body) => { patchedBody = body; return { ok: true, data: [{}] }; };

  await tracker.blockTask('task-id', 'Waiting on Zaal merge');
  assert.strictEqual(patchedBody.status, 'blocked');
  assert.ok(patchedBody.notes.includes('Waiting on Zaal merge'));
});

// ---- findByTitle -----------------------------------------------------------

test('CoworkTracker.findByTitle: returns rows array on success', async () => {
  const tracker = new CoworkTracker({ baseUrl: 'https://example.supabase.co', apiKey: 'key' });
  tracker._req = async () => ({ ok: true, data: [{ id: 'x', title: 'board keystone' }] });

  const result = await tracker.findByTitle('board keystone');
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.rows.length, 1);
  assert.strictEqual(result.rows[0].id, 'x');
});

// ---- _req network error handling ------------------------------------------

test('CoworkTracker._req: network error returns ok:false without throwing', async () => {
  const tracker = new CoworkTracker({ baseUrl: 'https://example.supabase.co', apiKey: 'key' });
  // Simulate fetch throwing (network down)
  const orig = global.fetch;
  global.fetch = async () => { throw new Error('ECONNREFUSED'); };
  try {
    const result = await tracker.getById('abc');
    assert.strictEqual(result.ok, false);
    assert.ok(result.error.includes('ECONNREFUSED'));
  } finally {
    global.fetch = orig;
  }
});

test('CoworkTracker._req: non-200 HTTP status returns ok:false', async () => {
  const tracker = new CoworkTracker({ baseUrl: 'https://example.supabase.co', apiKey: 'key' });
  const orig = global.fetch;
  global.fetch = makeFetch({ code: '42703', message: 'column not found' }, 400);
  try {
    const result = await tracker.getById('abc');
    assert.strictEqual(result.ok, false);
    assert.ok(result.error.includes('column not found') || result.error.includes('400'));
  } finally {
    global.fetch = orig;
  }
});

// ---- board handlers --------------------------------------------------------

test('board.task handlers: all six handlers are registered', async () => {
  const handlers = require('../handlers/index.js');
  const expected = [
    'board.task.create',
    'board.task.start',
    'board.task.finish',
    'board.task.block',
    'board.task.find',
    'board.task.update',
  ];
  for (const key of expected) {
    assert.ok(typeof handlers[key] === 'function', `${key} must be registered`);
  }
});

test('board.task.create handler: missing title returns ok:false', async () => {
  const handlers = require('../handlers/index.js');
  const result = await handlers['board.task.create']({ input: {} });
  assert.strictEqual(result.ok, false);
  assert.ok(result.error.includes('title is required'));
});

test('board.task.start handler: missing id returns ok:false', async () => {
  const handlers = require('../handlers/index.js');
  const result = await handlers['board.task.start']({ input: {} });
  assert.strictEqual(result.ok, false);
  assert.ok(result.error.includes('id is required'));
});

test('board.task.finish handler: missing id returns ok:false', async () => {
  const handlers = require('../handlers/index.js');
  const result = await handlers['board.task.finish']({ input: {} });
  assert.strictEqual(result.ok, false);
  assert.ok(result.error.includes('id is required'));
});

test('board.task.find handler: missing title returns ok:false', async () => {
  const handlers = require('../handlers/index.js');
  const result = await handlers['board.task.find']({ input: {} });
  assert.strictEqual(result.ok, false);
  assert.ok(result.error.includes('title is required'));
});

test('board.task.update handler: missing fields returns ok:false', async () => {
  const handlers = require('../handlers/index.js');
  const result = await handlers['board.task.update']({ input: { id: 'x' } });
  assert.strictEqual(result.ok, false);
  assert.ok(result.error.includes('fields object required'));
});
