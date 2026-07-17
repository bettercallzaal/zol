// src/cowork-tracker.js - Shared board-write helper for ZOL loops and agents.
// Wraps the Supabase cowork-tracker REST API (tasks table) so any loop or handler
// can open an in_progress row when it starts and close it done/blocked when it ends.
// Config: COWORK_TRACKER_URL + COWORK_TRACKER_KEY from env or opts.
// All writes are fire-and-forget safe — network errors are caught and returned as
// { ok: false, error } rather than thrown, so a board outage never blocks the loop.

'use strict';

// Default TTL for board task leases (board task 1163). Requires leased_until column.
const LEASE_TTL_MS = parseInt(process.env.COWORK_LEASE_TTL_MS || '600000', 10);

// ---------------------------------------------------------------------------
// COWORK CONSISTENCY standard: unified CoworkTask shape (Doc 1140 spec).
// All repos that write to the cowork board use these field names and vocab.
// ---------------------------------------------------------------------------

const COWORK_TASK_SCHEMA = {
  // Standard fields (id is the Supabase UUID primary key)
  fields: ['id', 'title', 'owner', 'status', 'priority', 'dueDate', 'brand', 'source', 'notes', 'ts'],
  // Normalized status vocab (maps from Supabase column values)
  statusVocab: { todo: 'open', in_progress: 'in-progress', done: 'done', blocked: 'blocked' },
  // Normalized priority vocab (maps from P1/P2/P3 to high/med/low)
  priorityVocab: { P1: 'high', P2: 'med', P3: 'low', P4: 'low' },
};

// Map a raw Supabase task row to the standard CoworkTask shape.
// Extra Supabase columns (category, legacy_id, etc.) are preserved in `_raw`.
function normalizeTask(row) {
  if (!row || typeof row !== 'object') return null;
  return {
    id:       row.id,
    title:    row.title || '',
    owner:    row.owner_id || null,
    status:   COWORK_TASK_SCHEMA.statusVocab[row.status] || row.status || 'open',
    priority: COWORK_TASK_SCHEMA.priorityVocab[row.priority] || row.priority || null,
    dueDate:  row.due || row.milestone_date || null,
    brand:    Array.isArray(row.brands) && row.brands.length ? row.brands[0] : null,
    source:   row.source || row.legacy_source || null,
    notes:    row.notes || null,
    ts:       row.updated_at || row.created_at || null,
    _raw:     row,
  };
}

const DEFAULT_BASE_URL = process.env.COWORK_TRACKER_URL || '';
const DEFAULT_KEY      = process.env.COWORK_TRACKER_KEY  || '';

class CoworkTracker {
  constructor(opts = {}) {
    this._url = (opts.baseUrl || DEFAULT_BASE_URL).replace(/\/$/, '');
    this._key = opts.apiKey || DEFAULT_KEY;
  }

  // ---- read ----------------------------------------------------------------

  async findByTitle(title) {
    const resp = await this._req('GET', `/rest/v1/tasks?title=ilike.${encodeURIComponent('%' + title + '%')}&limit=5`);
    if (!resp.ok) return { ok: false, error: resp.error, rows: [] };
    return { ok: true, rows: resp.data };
  }

  async getById(id) {
    const resp = await this._req('GET', `/rest/v1/tasks?id=eq.${encodeURIComponent(id)}&limit=1`);
    if (!resp.ok) return { ok: false, error: resp.error, row: null };
    return { ok: true, row: resp.data[0] || null };
  }

  // Fetch all open (non-done) tasks, ordered by priority then creation date.
  // Returns up to `limit` rows (default 100).
  // When normalize:true, rows are mapped to the standard CoworkTask shape.
  async listOpen({ limit = 100, normalize = false } = {}) {
    const resp = await this._req(
      'GET',
      `/rest/v1/tasks?select=id,title,status,priority,category,notes,owner_id,due,brands,source,legacy_source,created_at,updated_at&status=neq.done&order=priority.asc,created_at.asc&limit=${limit}`
    );
    if (!resp.ok) return { ok: false, error: resp.error, rows: [] };
    const raw = Array.isArray(resp.data) ? resp.data : [];
    return { ok: true, rows: normalize ? raw.map(normalizeTask) : raw };
  }

  // Run a lightweight triage pass: return the top-10 unblocked open tasks and
  // a list of likely-duplicate title pairs (same first 40 chars, different IDs).
  // Pure analysis — no writes. Caller decides which updates to make.
  async triage({ topN = 10 } = {}) {
    const open = await this.listOpen({ limit: 200 });
    if (!open.ok) return { ok: false, error: open.error };

    const rows = open.rows;

    // Dedup detection: group by normalized title prefix (first 40 chars, lowercase)
    const byPrefix = {};
    for (const r of rows) {
      const key = (r.title || '').toLowerCase().slice(0, 40).trim();
      if (!byPrefix[key]) byPrefix[key] = [];
      byPrefix[key].push(r);
    }
    const duplicateGroups = Object.values(byPrefix).filter(g => g.length > 1);

    // Top-N: exclude blocked, take first topN by priority order
    const unblocked = rows.filter(r => r.status !== 'blocked').slice(0, topN);

    return {
      ok: true,
      total: rows.length,
      top: unblocked,
      duplicateGroups,
      duplicateCount: duplicateGroups.reduce((n, g) => n + g.length - 1, 0),
    };
  }

  // ---- write ---------------------------------------------------------------

  // Create a new task row and immediately mark it in_progress.
  // Returns { ok, id, row }.
  async createTask(title, opts = {}) {
    const body = {
      title,
      status: 'in_progress',
      priority: opts.priority || 'P1',
      category: opts.category || 'ZAO Devz',
      notes: opts.notes || null,
    };
    const resp = await this._req('POST', '/rest/v1/tasks', body, { prefer: 'return=representation' });
    if (!resp.ok) return { ok: false, error: resp.error };
    const row = Array.isArray(resp.data) ? resp.data[0] : resp.data;
    return { ok: true, id: row && row.id, row };
  }

  // Transition an existing task to in_progress.
  async startTask(id, notes) {
    return this._patch(id, { status: 'in_progress', notes: notes || undefined });
  }

  // Atomic claim: transition todo → in_progress only if the task is still in 'todo' state.
  // If two agents race, only the first PATCH matches the ?status=eq.todo filter;
  // the second gets an empty result set and { ok: false, collision: true }.
  // Also accepts tasks in a custom fromStatus (e.g. 'pending') for flexibility.
  async claimTask(id, notes, { fromStatus = 'todo', claimerId } = {}) {
    const body = { status: 'in_progress', notes: notes || undefined };
    if (claimerId) body.claimer = claimerId;
    const resp = await this._req(
      'PATCH',
      `/rest/v1/tasks?id=eq.${encodeURIComponent(id)}&status=eq.${encodeURIComponent(fromStatus)}`,
      body,
      { prefer: 'return=representation' }
    );
    if (!resp.ok) return { ok: false, error: resp.error };
    const rows = Array.isArray(resp.data) ? resp.data : (resp.data ? [resp.data] : []);
    if (rows.length === 0) return { ok: false, collision: true };
    return { ok: true, row: rows[0] };
  }

  // TTL-based claim: sets leased_until so a crashed agent's lease expires and can be reclaimed.
  // Requires Supabase migration: ALTER TABLE tasks ADD COLUMN leased_until timestamptz;
  // Enable with COWORK_LEASE_ENABLED=1. Falls back to { ok: false, collision: true } if
  // the Supabase column is absent (the 400 from the primary PATCH short-circuits cleanly).
  // On primary collision, retries against rows where leased_until < now (expired lease).
  async claimWithLease(id, notes, { fromStatus = 'todo', claimerId, ttlMs = LEASE_TTL_MS } = {}) {
    const leasedUntil = new Date(Date.now() + ttlMs).toISOString();
    const body = { status: 'in_progress', leased_until: leasedUntil, notes: notes || undefined };
    if (claimerId) body.claimer = claimerId;
    const resp = await this._req(
      'PATCH',
      `/rest/v1/tasks?id=eq.${encodeURIComponent(id)}&status=eq.${encodeURIComponent(fromStatus)}`,
      body,
      { prefer: 'return=representation' }
    );
    if (!resp.ok) return { ok: false, error: resp.error };
    const rows = Array.isArray(resp.data) ? resp.data : (resp.data ? [resp.data] : []);
    if (rows.length > 0) return { ok: true, row: rows[0] };
    // Primary claim missed — try reclaiming an expired in_progress lease.
    const now = new Date().toISOString();
    const newLease = new Date(Date.now() + ttlMs).toISOString();
    const reclaimBody = { status: 'in_progress', leased_until: newLease, notes: notes || undefined };
    if (claimerId) reclaimBody.claimer = claimerId;
    const recResp = await this._req(
      'PATCH',
      `/rest/v1/tasks?id=eq.${encodeURIComponent(id)}&status=eq.in_progress&leased_until=lt.${encodeURIComponent(now)}`,
      reclaimBody,
      { prefer: 'return=representation' }
    );
    if (!recResp.ok) return { ok: false, collision: true };
    const recRows = Array.isArray(recResp.data) ? recResp.data : (recResp.data ? [recResp.data] : []);
    if (recRows.length > 0) return { ok: true, row: recRows[0], reclaimed: true };
    return { ok: false, collision: true };
  }

  // Transition to done and record the PR / doc link in notes.
  async finishTask(id, notes) {
    return this._patch(id, {
      status: 'done',
      notes,
      completed_at: new Date().toISOString(),
    });
  }

  // Transition to blocked with a reason.
  async blockTask(id, reason) {
    return this._patch(id, { status: 'blocked', notes: reason || undefined });
  }

  // Generic status update with arbitrary fields.
  async updateTask(id, fields) {
    return this._patch(id, fields);
  }

  // ---- helpers -------------------------------------------------------------

  async _patch(id, fields) {
    // Remove undefined values so we don't overwrite existing notes with null.
    const body = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
    const resp = await this._req('PATCH', `/rest/v1/tasks?id=eq.${encodeURIComponent(id)}`, body, {
      prefer: 'return=representation',
    });
    if (!resp.ok) return { ok: false, error: resp.error };
    const row = Array.isArray(resp.data) ? resp.data[0] : resp.data;
    return { ok: true, row };
  }

  async _req(method, path, body, opts = {}) {
    if (!this._url || !this._key) {
      return { ok: false, error: 'CoworkTracker: COWORK_TRACKER_URL/KEY not configured' };
    }
    const headers = {
      apikey: this._key,
      Authorization: `Bearer ${this._key}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
    if (opts.prefer) headers.Prefer = opts.prefer;

    try {
      const fetchOpts = { method, headers };
      if (body) fetchOpts.body = JSON.stringify(body);
      const res = await fetch(this._url + path, fetchOpts);
      let data = null;
      const text = await res.text();
      if (text) {
        try { data = JSON.parse(text); } catch (_) { data = text; }
      }
      if (!res.ok) {
        const msg = (data && (data.message || data.hint || data.code)) || String(res.status);
        return { ok: false, error: `HTTP ${res.status}: ${msg}` };
      }
      return { ok: true, data };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }
}

// Singleton — initialized lazily so missing env vars don't crash at require time.
let _instance = null;
function getTracker(opts) {
  if (opts) return new CoworkTracker(opts);
  if (!_instance) _instance = new CoworkTracker();
  return _instance;
}

module.exports = { CoworkTracker, getTracker, normalizeTask, COWORK_TASK_SCHEMA };
