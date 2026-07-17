'use strict';

// approval-bridge.js - Layer 10: Structured queuing, timeout, idempotency,
// and receipt generation wrapping the existing Telegram approval authority.
//
// This module does NOT send Telegram messages directly. The actual Telegram
// delivery is owned by the existing approval.request handler in
// src/handlers/index.js. This class is the durable queue and audit trail.
//
// CommonJS, no external npm dependencies.

const crypto = require('crypto');

// ---------------------------------------------------------------------------
// Secret redaction — same patterns as receipt-journal.js
// ---------------------------------------------------------------------------

const SECRET_PATTERNS = [
  /[0-9a-fA-F]{64}/g,      // 64-char hex (private keys)
  /sk-[a-zA-Z0-9_-]+/g,    // OpenAI / OpenRouter API keys
  /ghp_[a-zA-Z0-9_-]+/g,   // GitHub personal access tokens
];

/**
 * Recursively walk an object and replace secret-matching string values
 * with "[REDACTED]".
 */
function redact(obj) {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === 'string') {
    let result = obj;
    for (const pattern of SECRET_PATTERNS) {
      pattern.lastIndex = 0;
      result = result.replace(pattern, '[REDACTED]');
    }
    return result;
  }
  if (Array.isArray(obj)) {
    return obj.map(redact);
  }
  if (typeof obj === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      out[k] = redact(v);
    }
    return out;
  }
  return obj;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Derive a deterministic idempotency key from action + JSON-stable context
 * when the caller does not supply one explicitly.
 */
function deriveIdempotencyKey(action, context) {
  const payload = action + ':' + JSON.stringify(context, Object.keys(context || {}).sort());
  return crypto.createHash('sha256').update(payload, 'utf8').digest('hex');
}

// ---------------------------------------------------------------------------
// ApprovalBridge
// ---------------------------------------------------------------------------

class ApprovalBridge {
  /**
   * @param {object} stateStore     - state-adapter store (async get/put API)
   * @param {object} receiptJournal - ReceiptJournal instance (async append API)
   * @param {object} [opts]
   * @param {string} [opts.agentId='zolbot']
   * @param {string} [opts.capsuleId='zol-core-continuity-v1']
   * @param {number} [opts.defaultTimeoutMs=300000]
   */
  constructor(stateStore, receiptJournal, {
    agentId = 'zolbot',
    capsuleId = 'zol-core-continuity-v1',
    defaultTimeoutMs = 300000,
  } = {}) {
    if (!stateStore || typeof stateStore.get !== 'function' || typeof stateStore.put !== 'function') {
      throw new Error('ApprovalBridge: stateStore must have get() and put() methods');
    }
    if (!receiptJournal || typeof receiptJournal.append !== 'function') {
      throw new Error('ApprovalBridge: receiptJournal must have an append() method');
    }
    this._store = stateStore;
    this._journal = receiptJournal;
    this._agentId = agentId;
    this._capsuleId = capsuleId;
    this._defaultTimeoutMs = defaultTimeoutMs;

    // In-memory index mirror; loaded lazily.
    // Structure: { requestIds: string[], byIdempotencyKey: { [key]: string } }
    this._index = null;
  }

  // -------------------------------------------------------------------------
  // Private: index management
  // -------------------------------------------------------------------------

  async _loadIndex() {
    if (this._index !== null) return;
    const stored = await this._store.get('approval-bridge-index');
    if (stored && Array.isArray(stored.requestIds)) {
      this._index = stored;
    } else {
      this._index = { requestIds: [], byIdempotencyKey: {} };
    }
  }

  async _saveIndex() {
    await this._store.put('approval-bridge-index', this._index);
  }

  async _saveRequest(req) {
    await this._store.put('approval:' + req.requestId, req);
  }

  async _loadRequest(requestId) {
    if (!requestId) return null;
    const req = await this._store.get('approval:' + requestId);
    return req !== undefined ? req : null;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Create a new approval request and enqueue it.
   *
   * @param {object} [opts]
   * @param {string} opts.action           - what is being requested (required, non-empty)
   * @param {object} [opts.context={}]     - redacted context — no secrets, no private memory
   * @param {string} [opts.requestedBy='operator'] - loop or agent ID making the request
   * @param {string} [opts.idempotencyKey] - caller-supplied; derived if omitted
   * @param {number} [opts.timeoutMs]      - overrides defaultTimeoutMs
   * @returns {Promise<object>} approvalRequest
   */
  async request({
    action,
    context = {},
    requestedBy = 'operator',
    idempotencyKey,
    timeoutMs,
  } = {}) {
    if (!action || typeof action !== 'string' || action.trim() === '') {
      throw new Error('ApprovalBridge.request: action must be a non-empty string');
    }

    // Redact context before any processing or persistence
    const safeContext = redact(context);

    // Resolve idempotency key
    const iKey = idempotencyKey || deriveIdempotencyKey(action, safeContext);

    await this._loadIndex();

    // IDEMPOTENCY: if the same key exists and the request is still pending,
    // return the existing request without creating a duplicate.
    const existingId = this._index.byIdempotencyKey[iKey];
    if (existingId) {
      const existing = await this._loadRequest(existingId);
      if (existing && existing.status === 'pending') {
        return existing;
      }
    }

    const resolvedTimeoutMs = typeof timeoutMs === 'number' ? timeoutMs : this._defaultTimeoutMs;
    const createdAt = new Date().toISOString();
    const expiresAt = new Date(new Date(createdAt).getTime() + resolvedTimeoutMs).toISOString();
    const requestId = 'apr_' + crypto.randomUUID();

    const req = {
      requestId,
      idempotencyKey: iKey,
      action: action.trim(),
      context: safeContext,
      requestedBy,
      capsuleId: this._capsuleId,
      status: 'pending',
      createdAt,
      decidedAt: null,
      decidedBy: null,
      evidence: null,
      receiptId: null,
      timeoutMs: resolvedTimeoutMs,
      expiresAt,
    };

    // Persist the request
    await this._saveRequest(req);

    // Update index
    this._index.requestIds.push(requestId);
    this._index.byIdempotencyKey[iKey] = requestId;
    await this._saveIndex();

    // Append receipt
    let receiptId = null;
    try {
      const receipt = await this._journal.append({
        loopId: requestedBy,
        runId: requestId,
        capsuleId: this._capsuleId,
        action: 'approval.request',
        status: 'pending',
      });
      receiptId = receipt ? receipt.receiptId : null;
    } catch (_) {
      // Receipt failure is non-fatal — the request is already persisted.
    }

    if (receiptId) {
      req.receiptId = receiptId;
      await this._saveRequest(req);
    }

    return req;
  }

  /**
   * Record a decision (approved or denied) on an existing pending request.
   *
   * @param {string} requestId
   * @param {string} decision  - 'approved' | 'denied'
   * @param {object} [opts]
   * @param {string} [opts.decidedBy='operator']
   * @param {object} [opts.evidence={}]
   * @returns {Promise<object>} updated approvalRequest
   */
  async decide(requestId, decision, { decidedBy = 'operator', evidence = {} } = {}) {
    if (decision !== 'approved' && decision !== 'denied') {
      throw new Error("ApprovalBridge.decide: decision must be 'approved' or 'denied'");
    }

    const req = await this._loadRequest(requestId);
    if (!req) {
      throw new Error(`ApprovalBridge.decide: request not found: ${requestId}`);
    }
    if (req.status !== 'pending') {
      throw new Error(`ApprovalBridge.decide: request ${requestId} is not pending (status=${req.status})`);
    }

    const safeEvidence = redact(evidence);
    const decidedAt = new Date().toISOString();

    req.status = decision;
    req.decidedAt = decidedAt;
    req.decidedBy = decidedBy;
    req.evidence = safeEvidence;

    await this._saveRequest(req);

    // Append receipt
    const receiptStatus = decision === 'approved' ? 'success' : 'failure';
    try {
      await this._journal.append({
        loopId: req.requestedBy,
        runId: requestId,
        capsuleId: this._capsuleId,
        action: 'approval.decide',
        status: receiptStatus,
        evidence: safeEvidence,
      });
    } catch (_) {
      // Receipt failure is non-fatal.
    }

    return req;
  }

  /**
   * Cancel a pending request.
   *
   * @param {string} requestId
   * @returns {Promise<object>} updated approvalRequest
   */
  async cancel(requestId) {
    const req = await this._loadRequest(requestId);
    if (!req) {
      throw new Error(`ApprovalBridge.cancel: request not found: ${requestId}`);
    }
    if (req.status !== 'pending') {
      throw new Error(`ApprovalBridge.cancel: request ${requestId} is not pending (status=${req.status})`);
    }

    req.status = 'cancelled';
    req.decidedAt = new Date().toISOString();

    await this._saveRequest(req);

    try {
      await this._journal.append({
        loopId: req.requestedBy,
        runId: requestId,
        capsuleId: this._capsuleId,
        action: 'approval.cancel',
        status: 'success',
      });
    } catch (_) {
      // Receipt failure is non-fatal.
    }

    return req;
  }

  /**
   * Retrieve a single approval request by ID.
   *
   * @param {string} requestId
   * @returns {Promise<object|null>}
   */
  async get(requestId) {
    return this._loadRequest(requestId);
  }

  /**
   * Return all requests with status='pending'.
   *
   * @returns {Promise<object[]>}
   */
  async getPending() {
    return this.list({ status: 'pending', limit: Infinity });
  }

  /**
   * List approval requests, newest first.
   *
   * @param {object} [opts]
   * @param {string} [opts.status]   - filter by status
   * @param {number} [opts.limit=50] - max results
   * @returns {Promise<object[]>}
   */
  async list({ status, limit = 50 } = {}) {
    await this._loadIndex();

    const effectiveLimit = typeof limit === 'number' && isFinite(limit) ? limit : Infinity;
    const ids = [...this._index.requestIds].reverse();
    const results = [];

    for (const id of ids) {
      if (results.length >= effectiveLimit) break;
      const req = await this._loadRequest(id);
      if (!req) continue;
      if (status !== undefined && req.status !== status) continue;
      results.push(req);
    }

    return results;
  }

  /**
   * Scan all pending requests and mark any that have passed their expiresAt
   * timestamp as 'timeout'. Returns the count of requests expired.
   *
   * @returns {Promise<number>} count of requests marked as 'timeout'
   */
  async expirePending() {
    const pending = await this.getPending();
    const now = new Date();
    let count = 0;

    for (const req of pending) {
      if (new Date(req.expiresAt) < now) {
        req.status = 'timeout';
        req.decidedAt = now.toISOString();
        await this._saveRequest(req);

        try {
          await this._journal.append({
            loopId: req.requestedBy,
            runId: req.requestId,
            capsuleId: this._capsuleId,
            action: 'approval.timeout',
            status: 'failure',
          });
        } catch (_) {
          // Receipt failure is non-fatal.
        }

        count++;
      }
    }

    return count;
  }

  /**
   * One-use consume gate: atomically verify status='approved' and mark as
   * 'consumed'. Subsequent consume() calls on the same requestId throw
   * ALREADY_CONSUMED. Fails-closed on any error, missing request, or
   * non-approved status.
   *
   * This is the correct check to use before executing any approved action.
   * Use gate() only for non-consuming status inspections.
   *
   * @param {string} requestId
   * @returns {Promise<object>} the consumed approval record
   * @throws with code ALREADY_CONSUMED if already consumed
   * @throws with code GATE_DENIED for any other non-approved status
   */
  async consume(requestId) {
    let req;
    try {
      req = await this._loadRequest(requestId);
    } catch (err) {
      const e = new Error(`ApprovalBridge.consume: store error for ${requestId}: ${err.message} — DENIED`);
      e.code = 'GATE_DENIED';
      e.reason = 'store_error';
      throw e;
    }

    if (!req) {
      const e = new Error(`ApprovalBridge.consume: request ${requestId} not found — DENIED`);
      e.code = 'GATE_DENIED';
      e.reason = 'not_found';
      throw e;
    }

    if (req.status === 'consumed') {
      const e = new Error(`ApprovalBridge.consume: request ${requestId} was already consumed — replay rejected`);
      e.code = 'ALREADY_CONSUMED';
      e.reason = 'consumed';
      e.requestId = requestId;
      throw e;
    }

    if (req.status !== 'approved') {
      const reason = req.status === 'pending' ? 'pending'
        : req.status === 'timeout'   ? 'timeout'
        : req.status === 'denied'    ? 'denied'
        : req.status === 'cancelled' ? 'cancelled'
        : 'unknown';

      const e = new Error(
        `ApprovalBridge.consume: request ${requestId} is ${req.status} — DENIED. ` +
        `Action: ${req.action}`
      );
      e.code = 'GATE_DENIED';
      e.reason = reason;
      e.status = req.status;
      e.requestId = requestId;
      throw e;
    }

    // Atomically mark consumed
    req.status = 'consumed';
    req.consumedAt = new Date().toISOString();
    await this._saveRequest(req);

    return req;
  }

  /**
   * Fails-closed gate check (verification-gate invariant #3).
   *
   * Returns true if the given requestId has status='approved'.
   * Throws GateDeniedError on any other status or if the request is not found.
   * On ANY error (store failure, missing request, timeout, deny, ambiguity)
   * the action is DENIED — not allowed. There is no implicit allow.
   *
   * NOTE: gate() does not consume the approval. Use consume() for one-use
   * approval enforcement before executing an approved action.
   *
   * @param {string} requestId
   * @returns {Promise<true>}
   * @throws {GateDeniedError}
   */
  async gate(requestId) {
    let req;
    try {
      req = await this._loadRequest(requestId);
    } catch (err) {
      const e = new Error(`ApprovalBridge.gate: store error for ${requestId}: ${err.message} — DENIED (fails-closed)`);
      e.code = 'GATE_DENIED';
      e.reason = 'store_error';
      throw e;
    }

    if (!req) {
      const e = new Error(`ApprovalBridge.gate: request ${requestId} not found — DENIED (fails-closed)`);
      e.code = 'GATE_DENIED';
      e.reason = 'not_found';
      throw e;
    }

    if (req.status === 'approved') {
      return true;
    }

    const reason =
      req.status === 'pending'    ? 'pending' :
      req.status === 'timeout'    ? 'timeout' :
      req.status === 'denied'     ? 'denied' :
      req.status === 'cancelled'  ? 'cancelled' :
      'unknown';

    const e = new Error(
      `ApprovalBridge.gate: request ${requestId} is ${req.status} — DENIED (fails-closed). ` +
      `Action: ${req.action}, requestedBy: ${req.requestedBy}`
    );
    e.code = 'GATE_DENIED';
    e.reason = reason;
    e.status = req.status;
    e.requestId = requestId;
    throw e;
  }
}

// GateDeniedError sentinel — callers can check err.code === 'GATE_DENIED'
class GateDeniedError extends Error {
  constructor(msg, reason) {
    super(msg);
    this.name = 'GateDeniedError';
    this.code = 'GATE_DENIED';
    this.reason = reason;
  }
}

module.exports = { ApprovalBridge, GateDeniedError };
