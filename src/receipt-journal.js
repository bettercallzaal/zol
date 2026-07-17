'use strict';

// receipt-journal.js - Append-only, chained receipt log for ZOL DreamLoops
// CommonJS, no external dependencies.

const crypto = require('crypto');

// Secret patterns to strip from evidence before persisting
const SECRET_PATTERNS = [
  /[0-9a-fA-F]{64}/g,      // 64-char hex (private keys, hashes that look like keys)
  /sk-[a-zA-Z0-9_-]+/g,    // OpenAI / OpenRouter API keys
  /ghp_[a-zA-Z0-9_-]+/g,   // GitHub personal access tokens
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, // PEM blocks
];

/**
 * Recursively walk an object and replace secret-matching string values
 * with the placeholder "[REDACTED]".
 */
function sanitizeEvidence(obj) {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === 'string') {
    let result = obj;
    for (const pattern of SECRET_PATTERNS) {
      // Reset lastIndex for global patterns before each test
      pattern.lastIndex = 0;
      result = result.replace(pattern, '[REDACTED]');
    }
    return result;
  }
  if (Array.isArray(obj)) {
    return obj.map(sanitizeEvidence);
  }
  if (typeof obj === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      out[k] = sanitizeEvidence(v);
    }
    return out;
  }
  return obj;
}

/**
 * Compute the SHA-256 digest of the canonical receipt payload.
 * Keys are sorted alphabetically: receiptId, idempotencyKey, previousReceiptId,
 * loopId, runId, stepId, capsuleId, agentId, action, status, startedAt, evidence.
 */
function computeSha256(fields) {
  const canonical = JSON.stringify({
    receiptId: fields.receiptId,
    idempotencyKey: fields.idempotencyKey,
    previousReceiptId: fields.previousReceiptId,
    loopId: fields.loopId,
    runId: fields.runId,
    stepId: fields.stepId,
    capsuleId: fields.capsuleId,
    agentId: fields.agentId,
    action: fields.action,
    status: fields.status,
    startedAt: fields.startedAt,
    evidence: fields.evidence,
  });
  return crypto.createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/**
 * Derive the idempotency key from loopId + runId + optional stepId when the
 * caller does not supply one explicitly.
 */
function deriveIdempotencyKey(loopId, runId, stepId) {
  const input = `${loopId}:${runId}:${stepId || ''}`;
  return crypto.createHash('sha256').update(input, 'utf8').digest('hex');
}

// ---------------------------------------------------------------------------
// ReceiptJournal
// ---------------------------------------------------------------------------

class ReceiptJournal {
  /**
   * @param {object} stateStore  - state-adapter store (get/put async API)
   * @param {object} opts
   * @param {string} [opts.agentId="zolbot"]
   */
  constructor(stateStore, opts = {}) {
    if (!stateStore || typeof stateStore.get !== 'function' || typeof stateStore.put !== 'function') {
      throw new Error('ReceiptJournal: stateStore must have get() and put() methods');
    }
    this._store = stateStore;
    this._agentId = (opts && opts.agentId) || 'zolbot';

    // In-memory index mirror; loaded lazily from persistence.
    this._indexLoaded = false;
    // index structure: { receiptIds: string[], byIdempotencyKey: {[key]: string} }
  }

  // -------------------------------------------------------------------------
  // Private: index management
  // -------------------------------------------------------------------------

  async _loadIndex() {
    if (this._indexLoaded) return;
    const stored = await this._store.get('receipt-journal');
    if (stored && Array.isArray(stored.receiptIds)) {
      this._index = stored;
    } else {
      this._index = { receiptIds: [], byIdempotencyKey: {} };
    }
    this._indexLoaded = true;
  }

  async _saveIndex() {
    await this._store.put('receipt-journal', this._index);
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Append a new receipt.
   *
   * Required fields form the minimum viable receipt. Optional linking fields
   * (verification-gate invariant #4) form a complete chain:
   *   directive_id  → task_id → evidence → model_calls → tool_calls →
   *   approvals → outputs → state_transition → commit_hash
   *
   * @param {object} fields
   * @param {string}  fields.loopId
   * @param {string}  fields.runId
   * @param {string}  [fields.stepId]
   * @param {string}  fields.capsuleId
   * @param {string}  fields.action
   * @param {string}  fields.status        "success" | "failure" | "pending"
   * @param {object}  [fields.evidence]
   * @param {string}  [fields.idempotencyKey]
   * — Linking chain (invariant #4) —
   * @param {string}  [fields.directive_id]    - source directive that triggered this loop
   * @param {string}  [fields.task_id]         - work-router packetId this receipt covers
   * @param {Array}   [fields.model_calls]     - [{provider,model,tokens,cost},...] model invocations
   * @param {Array}   [fields.tool_calls]      - [{toolId,status,durationMs},...] tool invocations
   * @param {Array}   [fields.approvals]       - [{requestId,decision,decidedAt},...] approval records
   * @param {object}  [fields.outputs]         - structured outputs produced (e.g. {artifactId,...})
   * @param {string}  [fields.state_transition] - "pending→in_progress", "in_progress→done", etc.
   * @param {string}  [fields.commit_hash]     - git commit SHA of resulting deployment/change
   * @returns {Promise<object>} receipt
   */
  async append(fields) {
    const {
      loopId, runId, stepId = null, capsuleId, action, status, evidence = null,
      directive_id = null, task_id = null, model_calls = null, tool_calls = null,
      approvals = null, outputs = null, state_transition = null, commit_hash = null,
    } = fields;

    if (!loopId) throw new Error('ReceiptJournal.append: loopId is required');
    if (!runId) throw new Error('ReceiptJournal.append: runId is required');
    if (!capsuleId) throw new Error('ReceiptJournal.append: capsuleId is required');
    if (!action) throw new Error('ReceiptJournal.append: action is required');
    if (!status) throw new Error('ReceiptJournal.append: status is required');
    if (!['success', 'failure', 'pending'].includes(status)) {
      throw new Error(`ReceiptJournal.append: status must be "success", "failure", or "pending", got "${status}"`);
    }

    await this._loadIndex();

    // Resolve idempotency key
    const idempotencyKey = fields.idempotencyKey || deriveIdempotencyKey(loopId, runId, stepId);

    // IDEMPOTENCY: return existing receipt if key already seen
    const existingId = this._index.byIdempotencyKey[idempotencyKey];
    if (existingId) {
      return this.get(existingId);
    }

    // Determine chain link
    const receiptIds = this._index.receiptIds;
    const previousReceiptId = receiptIds.length > 0 ? receiptIds[receiptIds.length - 1] : null;

    // Build receipt (finishedAt / durationMs not set at append time for pending;
    // for success/failure we treat the append call as the completion moment)
    const receiptId = `rcpt_${crypto.randomUUID()}`;
    const startedAt = new Date().toISOString();
    const finishedAt = status !== 'pending' ? startedAt : null;
    const durationMs = status !== 'pending' ? 0 : null;

    const sanitizedEvidence = evidence !== null ? sanitizeEvidence(evidence) : null;

    // Build partial receipt (without sha256) to compute digest
    const partial = {
      receiptId,
      idempotencyKey,
      previousReceiptId,
      loopId,
      runId,
      stepId,
      capsuleId,
      agentId: this._agentId,
      action,
      status,
      startedAt,
      finishedAt,
      durationMs,
      evidence: sanitizedEvidence,
      // Linking chain fields (verification-gate invariant #4)
      directive_id,
      task_id,
      model_calls: model_calls !== null ? sanitizeEvidence(model_calls) : null,
      tool_calls: tool_calls !== null ? sanitizeEvidence(tool_calls) : null,
      approvals: approvals !== null ? sanitizeEvidence(approvals) : null,
      outputs: outputs !== null ? sanitizeEvidence(outputs) : null,
      state_transition,
      commit_hash,
    };

    const sha256 = computeSha256(partial);

    const receipt = {
      ...partial,
      sha256,
      version: 'v1',
    };

    // Persist individual receipt
    await this._store.put(`receipt:${receiptId}`, receipt);

    // Update and persist index
    this._index.receiptIds.push(receiptId);
    this._index.byIdempotencyKey[idempotencyKey] = receiptId;
    await this._saveIndex();

    return receipt;
  }

  /**
   * Retrieve a receipt by its receiptId.
   * @param {string} receiptId
   * @returns {Promise<object|null>}
   */
  async get(receiptId) {
    if (!receiptId) return null;
    const receipt = await this._store.get(`receipt:${receiptId}`);
    return receipt !== undefined ? receipt : null;
  }

  /**
   * Retrieve a receipt by idempotency key.
   * @param {string} key
   * @returns {Promise<object|null>}
   */
  async getByIdempotencyKey(key) {
    if (!key) return null;
    await this._loadIndex();
    const receiptId = this._index.byIdempotencyKey[key];
    if (!receiptId) return null;
    return this.get(receiptId);
  }

  /**
   * List receipts, newest first.
   * @param {object} [opts]
   * @param {string} [opts.loopId]  - filter by loopId
   * @param {number} [opts.limit]   - max receipts to return
   * @returns {Promise<object[]>}
   */
  async list(opts = {}) {
    await this._loadIndex();
    const { loopId, limit } = opts;

    // Collect receipts in reverse (newest first)
    const ids = [...this._index.receiptIds].reverse();
    const results = [];

    for (const id of ids) {
      if (typeof limit === 'number' && results.length >= limit) break;
      const receipt = await this.get(id);
      if (!receipt) continue;
      if (loopId && receipt.loopId !== loopId) continue;
      results.push(receipt);
    }

    return results;
  }

  /**
   * Return the most recent receipt, or null if journal is empty.
   * @returns {Promise<object|null>}
   */
  async getLatest() {
    await this._loadIndex();
    const ids = this._index.receiptIds;
    if (ids.length === 0) return null;
    return this.get(ids[ids.length - 1]);
  }
}

module.exports = { ReceiptJournal };
