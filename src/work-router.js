'use strict';

// work-router.js - Layer 6: Work Router for ZOL Persistent Agent Upgrade v2
// Ownership/fencing fields added per hardening pass Phase 1 item 5.
// Distinguishes conversation from real work, clarifies incomplete requests,
// creates work packets, routes tasks, resumes after restart, closes with evidence.

const crypto = require('crypto');

// Terminal statuses — once a packet reaches one of these, no further transitions allowed.
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);

// Default lease duration: 10 minutes
const DEFAULT_LEASE_TTL_MS = 10 * 60 * 1000;

// Default route map by work type (also handles 'auto' routing in route())
const DEFAULT_ROUTES = {
  research: 'dreamloop:research-and-citation-v1',
  curation: 'dreamloop:curator-brief-v1',
  artifact: 'dreamloop:artifact-plan-v1',
  reply: 'handler:approval.request',
  trapper: 'dreamloop:open-trapper-v1',
  other: 'operator',
};

// Action verbs that signal real work (not conversation).
// Spec-required set: research, write, find, analyze, draft, create, post, build,
// prepare, investigate, summarize, compare, generate, compile
const WORK_VERBS = new Set([
  'research', 'write', 'find', 'analyze', 'analyse', 'draft', 'create', 'post', 'build',
  'prepare', 'investigate', 'summarize', 'summarise', 'compare', 'generate', 'compile',
  // Extended verbs for broader coverage
  'review', 'audit', 'send', 'publish', 'fetch', 'gather', 'curate', 'code', 'implement',
  'design', 'plan', 'schedule', 'update', 'edit', 'fix', 'debug', 'deploy', 'migrate',
  'extract', 'convert',
]);

// Pure conversation / greeting patterns
const CONVERSATION_PATTERNS = [
  /^(hi|hello|hey|howdy|sup|yo|greetings)[!.,?\s]*$/i,
  /^how are you[?!.]*$/i,
  /^what('s| is) up[?!.]*$/i,
  /^(thanks|thank you|ty|thx)[!.,?\s]*$/i,
  /^(ok|okay|got it|sounds good|cool|great|awesome|perfect)[!.,?\s]*$/i,
  /^(yes|no|yeah|nope|yep|nah)[!.,?\s]*$/i,
];

// Infer work type from message text
function inferWorkType(lower) {
  if (/\b(research|find|gather|fetch|look up|look for|analyze|analyse|investigate|compare)\b/.test(lower)) {
    return 'research';
  }
  if (/\b(curate|curation|compile|collect|brief)\b/.test(lower)) {
    return 'curation';
  }
  if (/\b(code|implement|build|fix|debug|deploy|migrate)\b/.test(lower)) {
    return 'code';
  }
  if (/\b(reply|respond|send|post|publish)\b/.test(lower)) {
    return 'reply';
  }
  if (/\b(trap|trapper)\b/.test(lower)) {
    return 'trapper';
  }
  if (/\b(write|draft|compose|create|generate|summarize|summarise|prepare)\b/.test(lower)) {
    return 'artifact';
  }
  return 'other';
}

// Classify a message to determine if it represents real work.
// Confidence scale per spec:
//   0.9 for clear action verbs
//   0.6 for ambiguous
//   0.2 for questions / greetings
function classifyMessage(message) {
  if (!message || typeof message !== 'string') {
    return { isWork: false, workType: null, confidence: 1.0, reason: 'empty or non-string message' };
  }

  const trimmed = message.trim();

  // Pure greeting / acknowledgment
  for (const pattern of CONVERSATION_PATTERNS) {
    if (pattern.test(trimmed)) {
      return {
        isWork: false,
        workType: null,
        confidence: 0.9,
        reason: 'matches greeting/acknowledgment pattern',
      };
    }
  }

  // Short question heuristic
  if (trimmed.endsWith('?') && trimmed.split(/\s+/).length <= 10) {
    return {
      isWork: false,
      workType: null,
      confidence: 0.2,
      reason: 'short question (likely conversational)',
    };
  }

  const lower = trimmed.toLowerCase();
  const words = lower.split(/\W+/).filter(Boolean);
  const matchedVerbs = words.filter((w) => WORK_VERBS.has(w));

  if (matchedVerbs.length > 0) {
    const workType = inferWorkType(lower);
    return {
      isWork: true,
      workType,
      confidence: 0.9,
      reason: `contains action verb(s): ${[...new Set(matchedVerbs)].join(', ')}`,
    };
  }

  // Ambiguous — no clear verbs, not a greeting, not a short question
  return {
    isWork: false,
    workType: null,
    confidence: 0.6,
    reason: 'no clear action verbs or conversation markers detected',
  };
}

// Validate required fields for a work packet
function validatePacketFields(fields) {
  const required = ['title', 'description', 'type'];
  const missing = required.filter((f) => !fields[f]);
  if (missing.length > 0) {
    throw new Error(`WorkRouter.createPacket: missing required fields: ${missing.join(', ')}`);
  }

  const validTypes = ['research', 'artifact', 'code', 'curation', 'reply', 'trapper', 'other'];
  if (!validTypes.includes(fields.type)) {
    throw new Error(
      `WorkRouter.createPacket: invalid type "${fields.type}". Must be one of: ${validTypes.join(', ')}`
    );
  }
}

class WorkRouter {
  /**
   * @param {object} stateStore - State store instance (get/put interface)
   */
  constructor(stateStore) {
    if (!stateStore) throw new Error('WorkRouter requires a stateStore instance');
    this.store = stateStore;
    this._indexKey = 'work-router-index';
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  _packetKey(packetId) {
    return `work-router:${packetId}`;
  }

  async _getIndex() {
    const index = await this.store.get(this._indexKey);
    return index || [];
  }

  async _saveIndex(index) {
    await this.store.put(this._indexKey, index);
  }

  async _getPacket(packetId) {
    return this.store.get(this._packetKey(packetId));
  }

  async _savePacket(packet) {
    packet.updatedAt = new Date().toISOString();
    await this.store.put(this._packetKey(packet.packetId), packet);
    // Sync the index entry for this packet so filters on index metadata stay accurate
    await this._syncIndexEntry(packet);
    return packet;
  }

  async _syncIndexEntry(packet) {
    const index = await this._getIndex();
    const entry = {
      packetId: packet.packetId,
      status: packet.status,
      type: packet.type,
      priority: packet.priority,
      createdAt: packet.createdAt,
    };

    const idx = index.findIndex((e) => e.packetId === packet.packetId);
    if (idx === -1) {
      // Prepend so newest-first order is maintained
      index.unshift(entry);
    } else {
      index[idx] = entry;
    }

    await this._saveIndex(index);
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Classify a message to determine if it represents real work.
   * @param {string} message
   * @returns {{ isWork: boolean, workType: string|null, confidence: number, reason: string }}
   */
  classify(message) {
    return classifyMessage(message);
  }

  /**
   * Create a new work packet.
   * @param {{ title, description, type, priority?, requestedBy?, inputs?, tags[], sideEffectKey? }} fields
   * @returns {object} The created packet
   */
  async createPacket({ title, description, type, priority = 'medium', requestedBy = 'operator', inputs = {}, tags = [], sideEffectKey = null } = {}) {
    validatePacketFields({ title, description, type });

    const now = new Date().toISOString();
    const packetId = 'work_' + crypto.randomUUID();

    const packet = {
      packetId,
      title,
      description,
      type,
      status: 'pending',
      priority,
      requestedBy,
      // Ownership/fencing fields (hardening pass Phase 1, item 5)
      owner: null,         // identity of the agent holding the lease
      attemptId: null,     // unique ID per lease acquisition; changes on re-acquire
      fencingEpoch: 0,     // monotonically increasing; reject stale writers
      leaseExpiry: null,   // ISO timestamp; null when not in_progress
      sideEffectKey,       // caller-supplied idempotency key for side-effecting actions
      assignedTo: null,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
      inputs,
      clarificationsNeeded: [],
      clarificationsReceived: {},
      evidence: null,
      receipts: [],
      route: null,
      resumeCheckpoint: null,
      tags,
    };

    await this.store.put(this._packetKey(packetId), packet);
    await this._syncIndexEntry(packet);

    return packet;
  }

  /**
   * Set status to clarification_needed and append questions to clarificationsNeeded.
   * @param {string} packetId
   * @param {string[]} questions
   * @returns {object} Updated packet
   */
  async clarify(packetId, questions) {
    const packet = await this._getPacket(packetId);
    if (!packet) throw new Error(`WorkRouter.clarify: packet not found: ${packetId}`);

    packet.status = 'clarification_needed';
    const existing = new Set(packet.clarificationsNeeded);
    for (const q of questions) {
      if (!existing.has(q)) {
        packet.clarificationsNeeded.push(q);
        existing.add(q);
      }
    }

    return this._savePacket(packet);
  }

  /**
   * Provide answers to clarification questions.
   * If all questions are answered, status returns to "pending".
   * @param {string} packetId
   * @param {object} answers - Map of question -> answer
   * @returns {object} Updated packet
   */
  async provideAnswers(packetId, answers) {
    const packet = await this._getPacket(packetId);
    if (!packet) throw new Error(`WorkRouter.provideAnswers: packet not found: ${packetId}`);

    Object.assign(packet.clarificationsReceived, answers);

    const allAnswered =
      packet.clarificationsNeeded.length > 0 &&
      packet.clarificationsNeeded.every((q) => packet.clarificationsReceived[q] !== undefined);

    if (allAnswered && packet.status === 'clarification_needed') {
      packet.status = 'pending';
    }

    return this._savePacket(packet);
  }

  /**
   * Assign a route to the packet, acquire a lease, and set status to in_progress.
   *
   * @param {string} packetId
   * @param {string} route - Route identifier, or 'auto' for type-based default
   * @param {object} [opts]
   * @param {string} [opts.owner]      - Identity of the acquiring agent
   * @param {number} [opts.leaseTtlMs] - Lease duration in ms (default: 10 min)
   * @param {string} [opts.expectedStatus] - CAS guard: only route if current status matches
   * @returns {object} Updated packet with lease fields
   */
  async route(packetId, route, { owner = 'operator', leaseTtlMs = DEFAULT_LEASE_TTL_MS, expectedStatus } = {}) {
    const packet = await this._getPacket(packetId);
    if (!packet) throw new Error(`WorkRouter.route: packet not found: ${packetId}`);

    // Terminal status check: cannot re-route a terminated packet
    if (TERMINAL_STATUSES.has(packet.status)) {
      const err = new Error(
        `WorkRouter.route: packet ${packetId} is in terminal status "${packet.status}" — cannot re-route`
      );
      err.code = 'TERMINAL_STATUS';
      err.status = packet.status;
      throw err;
    }

    // CAS guard: if expectedStatus is set, reject if current status doesn't match
    if (expectedStatus !== undefined && packet.status !== expectedStatus) {
      const err = new Error(
        `WorkRouter.route: CAS failed for ${packetId} — expected "${expectedStatus}", got "${packet.status}"`
      );
      err.code = 'CAS_MISMATCH';
      err.expected = expectedStatus;
      err.actual = packet.status;
      throw err;
    }

    // Lease guard (verification-gate invariant #2): reject duplicate assignment
    // unless the existing lease has expired.
    if (packet.status === 'in_progress') {
      const now = Date.now();
      const expiry = packet.leaseExpiry ? new Date(packet.leaseExpiry).getTime() : 0;
      if (now < expiry) {
        const err = new Error(
          `WorkRouter.route: lease already held by "${packet.assignedTo}" for packet ${packetId} ` +
          `(expires ${packet.leaseExpiry})`
        );
        err.code = 'LEASE_ALREADY_HELD';
        err.assignedTo = packet.assignedTo;
        err.leaseExpiry = packet.leaseExpiry;
        throw err;
      }
      // Lease is expired — allow re-acquisition (fencing epoch will increment)
    }

    const resolvedRoute =
      route === 'auto'
        ? DEFAULT_ROUTES[packet.type] || DEFAULT_ROUTES.other
        : route;

    const now = new Date();
    packet.route = resolvedRoute;
    packet.assignedTo = resolvedRoute;
    packet.owner = owner;
    packet.attemptId = 'attempt_' + crypto.randomUUID();
    packet.fencingEpoch = (packet.fencingEpoch || 0) + 1;
    packet.leaseExpiry = new Date(now.getTime() + leaseTtlMs).toISOString();
    packet.status = 'in_progress';

    return this._savePacket(packet);
  }

  /**
   * Renew a held lease, extending the expiry by leaseTtlMs.
   * The caller must supply the current attemptId to prove they still hold the lease.
   *
   * @param {string} packetId
   * @param {string} attemptId - The attemptId returned when the lease was acquired
   * @param {number} [leaseTtlMs]
   * @returns {object} Updated packet
   */
  async renewLease(packetId, attemptId, leaseTtlMs = DEFAULT_LEASE_TTL_MS) {
    const packet = await this._getPacket(packetId);
    if (!packet) throw new Error(`WorkRouter.renewLease: packet not found: ${packetId}`);
    if (packet.status !== 'in_progress') {
      throw new Error(`WorkRouter.renewLease: packet ${packetId} is not in_progress (status: ${packet.status})`);
    }
    if (packet.attemptId !== attemptId) {
      const err = new Error(
        `WorkRouter.renewLease: stale lease for packet ${packetId} — ` +
        `caller attemptId="${attemptId}" but current="${packet.attemptId}" (fencing epoch ${packet.fencingEpoch})`
      );
      err.code = 'STALE_LEASE';
      err.fencingEpoch = packet.fencingEpoch;
      throw err;
    }
    packet.leaseExpiry = new Date(Date.now() + leaseTtlMs).toISOString();
    return this._savePacket(packet);
  }

  /**
   * Save a resume checkpoint for mid-work restarts.
   * @param {string} packetId
   * @param {object} checkpointState
   * @returns {object} Updated packet
   */
  async checkpoint(packetId, checkpointState) {
    const packet = await this._getPacket(packetId);
    if (!packet) throw new Error(`WorkRouter.checkpoint: packet not found: ${packetId}`);

    packet.resumeCheckpoint = checkpointState;

    return this._savePacket(packet);
  }

  /**
   * Return the full packet (including resumeCheckpoint) for post-restart resumption.
   * @param {string} packetId
   * @returns {object|null}
   */
  async resume(packetId) {
    return (await this._getPacket(packetId)) || null;
  }

  /**
   * Mark the packet as completed with evidence.
   * The caller should supply their attemptId to guard against stale writers.
   * @param {string} packetId
   * @param {object} evidence
   * @param {object} [opts]
   * @param {string} [opts.attemptId] - Guard: reject if packet's attemptId doesn't match
   * @returns {object} Updated packet
   */
  async complete(packetId, evidence, { attemptId } = {}) {
    const packet = await this._getPacket(packetId);
    if (!packet) throw new Error(`WorkRouter.complete: packet not found: ${packetId}`);
    if (TERMINAL_STATUSES.has(packet.status)) {
      const err = new Error(`WorkRouter.complete: packet ${packetId} is already in terminal status "${packet.status}"`);
      err.code = 'TERMINAL_STATUS';
      throw err;
    }
    if (attemptId !== undefined && packet.attemptId !== attemptId) {
      const err = new Error(`WorkRouter.complete: stale writer for ${packetId} — attemptId mismatch`);
      err.code = 'STALE_LEASE';
      throw err;
    }

    packet.status = 'completed';
    packet.evidence = evidence || null;
    packet.completedAt = new Date().toISOString();
    packet.leaseExpiry = null;

    return this._savePacket(packet);
  }

  /**
   * Mark the packet as failed; stores reason in evidence.
   * @param {string} packetId
   * @param {string} reason
   * @param {object} [opts]
   * @param {string} [opts.attemptId]
   * @returns {object} Updated packet
   */
  async fail(packetId, reason, { attemptId } = {}) {
    const packet = await this._getPacket(packetId);
    if (!packet) throw new Error(`WorkRouter.fail: packet not found: ${packetId}`);
    if (TERMINAL_STATUSES.has(packet.status)) {
      const err = new Error(`WorkRouter.fail: packet ${packetId} is already in terminal status "${packet.status}"`);
      err.code = 'TERMINAL_STATUS';
      throw err;
    }
    if (attemptId !== undefined && packet.attemptId !== attemptId) {
      const err = new Error(`WorkRouter.fail: stale writer for ${packetId} — attemptId mismatch`);
      err.code = 'STALE_LEASE';
      throw err;
    }

    packet.status = 'failed';
    packet.evidence = { reason };
    packet.leaseExpiry = null;

    return this._savePacket(packet);
  }

  /**
   * Cancel a work packet.
   * @param {string} packetId
   * @returns {object} Updated packet
   */
  async cancel(packetId) {
    const packet = await this._getPacket(packetId);
    if (!packet) throw new Error(`WorkRouter.cancel: packet not found: ${packetId}`);
    if (TERMINAL_STATUSES.has(packet.status)) {
      const err = new Error(`WorkRouter.cancel: packet ${packetId} is already in terminal status "${packet.status}"`);
      err.code = 'TERMINAL_STATUS';
      throw err;
    }

    packet.status = 'cancelled';
    packet.leaseExpiry = null;

    return this._savePacket(packet);
  }

  /**
   * Get a single packet by ID.
   * @param {string} packetId
   * @returns {object|null}
   */
  async get(packetId) {
    return (await this._getPacket(packetId)) || null;
  }

  /**
   * List packets with optional filters, newest first.
   * @param {{ status?, type?, limit? }} opts
   * @returns {object[]}
   */
  async list({ status, type, limit = 50 } = {}) {
    const index = await this._getIndex();
    const results = [];

    for (const entry of index) {
      if (results.length >= limit) break;

      // Fast-path filter on index metadata before fetching full packet
      if (status !== undefined && entry.status !== status) continue;
      if (type !== undefined && entry.type !== type) continue;

      const packet = await this._getPacket(entry.packetId);
      if (!packet) continue;

      results.push(packet);
    }

    return results;
  }

  /**
   * List all packets with status "clarification_needed".
   * @returns {object[]}
   */
  async listPendingClarification() {
    return this.list({ status: 'clarification_needed' });
  }
}

module.exports = { WorkRouter };
