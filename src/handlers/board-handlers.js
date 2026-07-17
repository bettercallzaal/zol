// src/handlers/board-handlers.js - DreamLoop handler bindings for the cowork board.
// Exposes board.task.create / .start / .finish / .block / .find so any loop step
// can update the board without importing CoworkTracker directly.
// All handlers are fire-and-forget safe: a board error returns ok:false but never throws.

// FIELD DRIFT GUIDE — CoworkTracker / Supabase REST (COWORK_TRACKER_URL/rest/v1/tasks)
// If board.task.* handlers return empty results or 400s, check these first:
//
// Table columns (as of 2026-07-17, post-PR #1279 cowork-rls-hardening):
//   id (uuid), title (text), status (text), priority (text),
//   category (text), notes (text), created_at (timestamptz),
//   completed_at (timestamptz), owner_id (text)
//   NO 'assignee' column — use owner_id instead.
//
// OPTIONAL (TTL lease, board task 1163): add leased_until column to enable
//   atomic lease-based reclaim (COWORK_LEASE_ENABLED=1 in env):
//   ALTER TABLE tasks ADD COLUMN leased_until timestamptz;
//
// Status vocab: 'todo' | 'in_progress' | 'done' | 'blocked'
// Priority vocab: 'high' | 'med' | 'low'  (NOT P1/P2/P3 — normalizeTask() converts)
//
// DRIFT RISK: RLS policy change — after PR #1279 (drops authenticated_all), ZOL must
//   use service_role key or explicit anon tasks policy. If 403s appear, check RLS.
// DRIFT RISK: Supabase REST filter syntax — ?status=eq.todo uses eq., not =.
//   ilike filter: ?title=ilike.*keyword* (percent-encoded in URL if needed).
// DRIFT RISK: PATCH response for conditional update (?status=eq.todo): empty array []
//   means collision (another agent claimed); non-empty means success.
//
// Supabase REST docs: https://supabase.com/docs/guides/api/rest
// Last verified: 2026-07-17

'use strict';

const { getTracker } = require('../cowork-tracker');

const handlers = {
  // Create a new board row and mark it in_progress immediately.
  // input: { title, priority?, category?, notes? }
  // output: { ok, id?, row?, error? }
  'board.task.create': async function({ input }) {
    const { title, priority, category, notes } = input || {};
    if (!title) return { ok: false, error: 'board.task.create: title is required' };
    return getTracker().createTask(title, { priority, category, notes });
  },

  // Mark an existing task in_progress.
  // input: { id, notes? }
  'board.task.start': async function({ input }) {
    const { id, notes } = input || {};
    if (!id) return { ok: false, error: 'board.task.start: id is required' };
    return getTracker().startTask(id, notes);
  },

  // Atomic conditional claim: todo → in_progress only if task is still todo.
  // Prevents two agent clones from both claiming the same task (shared-clone collision).
  // Returns { ok: false, collision: true } if another agent already claimed it.
  // With COWORK_LEASE_ENABLED=1: uses TTL-based lease so expired in_progress tasks
  // can be reclaimed (requires leased_until column — see FIELD DRIFT GUIDE above).
  // input: { id, notes?, fromStatus?, claimerId? }
  'board.task.claim': async function({ input }) {
    const { id, notes, fromStatus, claimerId } = input || {};
    if (!id) return { ok: false, error: 'board.task.claim: id is required' };
    const tracker = getTracker();
    if (process.env.COWORK_LEASE_ENABLED === '1') {
      return tracker.claimWithLease(id, notes, { fromStatus, claimerId });
    }
    return tracker.claimTask(id, notes, { fromStatus, claimerId });
  },

  // Mark an existing task done.
  // input: { id, notes } — notes should include PR/doc link
  'board.task.finish': async function({ input }) {
    const { id, notes } = input || {};
    if (!id) return { ok: false, error: 'board.task.finish: id is required' };
    return getTracker().finishTask(id, notes);
  },

  // Mark an existing task blocked.
  // input: { id, reason? }
  'board.task.block': async function({ input }) {
    const { id, reason } = input || {};
    if (!id) return { ok: false, error: 'board.task.block: id is required' };
    return getTracker().blockTask(id, reason);
  },

  // Find tasks by title substring.
  // input: { title }
  // output: { ok, rows?, error? }
  'board.task.find': async function({ input }) {
    const { title } = input || {};
    if (!title) return { ok: false, error: 'board.task.find: title is required' };
    return getTracker().findByTitle(title);
  },

  // Generic update — for nightly triage (rerank, set notes, etc).
  // input: { id, fields: { status?, priority?, notes?, ... } }
  'board.task.update': async function({ input }) {
    const { id, fields } = input || {};
    if (!id) return { ok: false, error: 'board.task.update: id is required' };
    if (!fields || typeof fields !== 'object') return { ok: false, error: 'board.task.update: fields object required' };
    return getTracker().updateTask(id, fields);
  },

  // Fetch all open tasks (non-done), ordered by priority.
  // input: { limit? }
  // output: { ok, rows, total? }
  'board.task.list-open': async function({ input }) {
    const { limit } = input || {};
    return getTracker().listOpen({ limit });
  },

  // Run the lightweight triage pass: top-10 unblocked open tasks + duplicate pairs.
  // Pure analysis — no writes made.
  // input: { topN? }
  // output: { ok, total, top, duplicateGroups, duplicateCount }
  'board.triage.run': async function({ input }) {
    const { topN } = input || {};
    return getTracker().triage({ topN });
  },
};

module.exports = { handlers };
