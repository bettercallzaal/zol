// src/__tests__/cowork-tracker.test.js
// Unit tests for CoworkTracker using a mock fetch (no real network calls).
// All board writes are fire-and-forget safe — errors return ok:false, never throw.

const test  = require('node:test');
const assert = require('node:assert');
const { CoworkTracker, normalizeTask, COWORK_TASK_SCHEMA } = require('../cowork-tracker');

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

test('board.task handlers: all eight handlers are registered', async () => {
  const handlers = require('../handlers/index.js');
  const expected = [
    'board.task.create',
    'board.task.start',
    'board.task.finish',
    'board.task.block',
    'board.task.find',
    'board.task.update',
    'board.task.list-open',
    'board.triage.run',
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

// ---- listOpen / triage --------------------------------------------------------

test('CoworkTracker.listOpen: returns ok+rows on success', async () => {
  const tracker = new CoworkTracker({ baseUrl: 'https://example.supabase.co', apiKey: 'key' });
  tracker._req = async () => ({
    ok: true,
    data: [
      { id: '1', title: 'Task A', status: 'todo', priority: 'P1' },
      { id: '2', title: 'Task B', status: 'in_progress', priority: 'P2' },
    ],
  });

  const result = await tracker.listOpen();
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.rows.length, 2);
});

test('CoworkTracker.listOpen: API error returns ok:false with empty rows', async () => {
  const tracker = new CoworkTracker({ baseUrl: 'https://example.supabase.co', apiKey: 'key' });
  tracker._req = async () => ({ ok: false, error: 'network error' });

  const result = await tracker.listOpen();
  assert.strictEqual(result.ok, false);
  assert.deepStrictEqual(result.rows, []);
});

test('CoworkTracker.triage: surfaces top-N and detects duplicate titles', async () => {
  const tracker = new CoworkTracker({ baseUrl: 'https://example.supabase.co', apiKey: 'key' });
  // Two tasks share the same normalized title prefix → detected as duplicates.
  // Use a title short enough that both entries map to the same key after slice(0,40).
  const sharedTitle = 'Fix login bug';
  const rows = [
    { id: '1', title: sharedTitle, status: 'todo', priority: 'P1' },
    { id: '2', title: sharedTitle, status: 'todo', priority: 'P1' },
    { id: '3', title: 'Upgrade database migration scripts', status: 'todo', priority: 'P2' },
    { id: '4', title: 'Write unit tests for auth module', status: 'blocked', priority: 'P1' },
  ];
  tracker._req = async () => ({ ok: true, data: rows });

  const result = await tracker.triage({ topN: 10 });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.total, 4);
  // blocked task excluded from top
  assert.ok(!result.top.some(r => r.status === 'blocked'), 'blocked tasks should not appear in top');
  // duplicate detected: first 40 chars of "Fix the login bug on mobile app" match
  assert.ok(result.duplicateCount > 0, 'should detect at least 1 duplicate pair');
});

test('CoworkTracker.triage: API error propagates ok:false', async () => {
  const tracker = new CoworkTracker({ baseUrl: 'https://example.supabase.co', apiKey: 'key' });
  tracker._req = async () => ({ ok: false, error: 'board down' });

  const result = await tracker.triage();
  assert.strictEqual(result.ok, false);
  assert.ok(result.error.includes('board down'));
});

test('board.triage.run handler: is registered and callable', async () => {
  const handlers = require('../handlers/index.js');
  assert.ok(typeof handlers['board.triage.run'] === 'function');
  // With missing config (no real URL), should return ok:false without throwing
  const result = await handlers['board.triage.run']({ input: {} });
  // Either ok:false (no config) or ok:true (if env vars happen to be set)
  assert.ok(typeof result.ok === 'boolean');
});

test('board.task.list-open handler: is registered and callable', async () => {
  const handlers = require('../handlers/index.js');
  assert.ok(typeof handlers['board.task.list-open'] === 'function');
  const result = await handlers['board.task.list-open']({ input: {} });
  assert.ok(typeof result.ok === 'boolean');
});

// ---- normalizeTask / COWORK_TASK_SCHEMA ----------------------------------------

test('COWORK_TASK_SCHEMA: has required fields and vocab entries', () => {
  assert.ok(Array.isArray(COWORK_TASK_SCHEMA.fields));
  const required = ['id', 'title', 'owner', 'status', 'priority', 'dueDate', 'brand', 'source', 'notes', 'ts'];
  for (const f of required) {
    assert.ok(COWORK_TASK_SCHEMA.fields.includes(f), `schema.fields must include ${f}`);
  }
  assert.strictEqual(COWORK_TASK_SCHEMA.statusVocab['todo'], 'open');
  assert.strictEqual(COWORK_TASK_SCHEMA.statusVocab['in_progress'], 'in-progress');
  assert.strictEqual(COWORK_TASK_SCHEMA.statusVocab['done'], 'done');
  assert.strictEqual(COWORK_TASK_SCHEMA.statusVocab['blocked'], 'blocked');
  assert.strictEqual(COWORK_TASK_SCHEMA.priorityVocab['P1'], 'high');
  assert.strictEqual(COWORK_TASK_SCHEMA.priorityVocab['P2'], 'med');
  assert.strictEqual(COWORK_TASK_SCHEMA.priorityVocab['P3'], 'low');
});

test('normalizeTask: maps Supabase row to standard CoworkTask shape', () => {
  const row = {
    id: 'abc-123',
    title: 'Fix the login bug',
    owner_id: 'user-456',
    status: 'in_progress',
    priority: 'P1',
    due: '2026-08-01',
    brands: ['zao'],
    source: 'human-web',
    notes: 'See doc 1140',
    updated_at: '2026-07-17T00:00:00Z',
    created_at: '2026-07-16T00:00:00Z',
    category: 'ZAO Devz',
  };

  const task = normalizeTask(row);

  assert.strictEqual(task.id, 'abc-123');
  assert.strictEqual(task.title, 'Fix the login bug');
  assert.strictEqual(task.owner, 'user-456');
  assert.strictEqual(task.status, 'in-progress');
  assert.strictEqual(task.priority, 'high');
  assert.strictEqual(task.dueDate, '2026-08-01');
  assert.strictEqual(task.brand, 'zao');
  assert.strictEqual(task.source, 'human-web');
  assert.strictEqual(task.notes, 'See doc 1140');
  assert.strictEqual(task.ts, '2026-07-17T00:00:00Z');
  assert.deepStrictEqual(task._raw, row, '_raw must preserve original row');
});

test('normalizeTask: handles missing optional fields gracefully', () => {
  const task = normalizeTask({ id: 'x', title: 'Minimal', status: 'todo', priority: 'P2' });
  assert.strictEqual(task.status, 'open');
  assert.strictEqual(task.priority, 'med');
  assert.strictEqual(task.owner, null);
  assert.strictEqual(task.dueDate, null);
  assert.strictEqual(task.brand, null);
  assert.strictEqual(task.ts, null);
});

test('normalizeTask: returns null for null/undefined input', () => {
  assert.strictEqual(normalizeTask(null), null);
  assert.strictEqual(normalizeTask(undefined), null);
});

test('CoworkTracker.listOpen: normalize:true returns CoworkTask-shaped rows', async () => {
  const tracker = new CoworkTracker({ baseUrl: 'https://example.supabase.co', apiKey: 'key' });
  tracker._req = async () => ({
    ok: true,
    data: [
      { id: '1', title: 'Task A', status: 'todo', priority: 'P1', owner_id: null, due: null, brands: [], source: 'human-web', notes: null, created_at: '2026-07-01', updated_at: null },
    ],
  });

  const result = await tracker.listOpen({ normalize: true });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.rows.length, 1);
  assert.strictEqual(result.rows[0].status, 'open');
  assert.strictEqual(result.rows[0].priority, 'high');
  assert.ok('_raw' in result.rows[0], 'normalized row must have _raw');
});
