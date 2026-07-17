// memory-weaver.js - Persistent agent memory layer for ZOL DreamLoops v2
// Provides typed memory storage (working, episodic, relationship, project, source)
// with deduplication, secret stripping, contradiction detection, and freshness tracking.
//
// State keys:
//   "memory-index"          - array of {memoryId, type, subtype, dedupeKey, tags, visibility, stale, createdAt}
//   "memory:{memoryId}"     - individual memory entry

'use strict';

const crypto = require('crypto');

// Secret patterns that must be stripped from content before storage
const SECRET_PATTERNS = [
  /[0-9a-fA-F]{64}/g,       // 64-char hex (private keys, hashes)
  /sk-[a-zA-Z0-9_-]+/g,     // OpenAI/OpenRouter secret keys
  /ghp_[a-zA-Z0-9_-]+/g,    // GitHub personal access tokens
];

const VALID_TYPES = ['working', 'episodic', 'relationship', 'project', 'source'];
const VALID_VISIBILITIES = ['private', 'public'];
const VALID_SOURCE_TYPES = ['dreamloop', 'handler', 'operator', 'external'];

// Strip secret patterns from a value (deep, works on strings and objects/arrays)
function stripSecrets(value) {
  if (typeof value === 'string') {
    let result = value;
    for (const pattern of SECRET_PATTERNS) {
      pattern.lastIndex = 0;
      result = result.replace(pattern, '[REDACTED]');
    }
    return result;
  }
  if (Array.isArray(value)) {
    return value.map(stripSecrets);
  }
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = stripSecrets(v);
    }
    return out;
  }
  return value;
}

// Validate a memory entry — throws if invalid
function validateEntry(entry) {
  if (!entry || typeof entry !== 'object') throw new Error('memory entry must be an object');

  if (!VALID_TYPES.includes(entry.type)) {
    throw new Error(`invalid memory type "${entry.type}"; must be one of: ${VALID_TYPES.join(', ')}`);
  }

  if (entry.content === undefined || entry.content === null || entry.content === '') {
    throw new Error('memory entry must have non-empty content');
  }

  if (!Array.isArray(entry.tags)) {
    throw new Error('memory entry tags must be an array');
  }

  if (!entry.provenance || typeof entry.provenance !== 'object') {
    throw new Error('memory entry must have a provenance object');
  }
  if (!entry.provenance.sourceType) {
    throw new Error('provenance.sourceType is required');
  }
  if (typeof entry.provenance.confidence !== 'number' ||
      entry.provenance.confidence < 0 || entry.provenance.confidence > 1) {
    throw new Error('provenance.confidence must be a number between 0.0 and 1.0');
  }

  if (!entry.freshness || typeof entry.freshness !== 'object') {
    throw new Error('memory entry must have a freshness object');
  }

  const vis = entry.visibility;
  if (vis && !VALID_VISIBILITIES.includes(vis)) {
    throw new Error(`invalid visibility "${vis}"; must be "private" or "public"`);
  }

  if (!Array.isArray(entry.contradictions)) {
    throw new Error('memory entry contradictions must be an array');
  }
}

// Build a fully-formed memory entry from partial input
function buildEntry(partial) {
  const now = new Date().toISOString();
  const memoryId = partial.memoryId || `mem_${crypto.randomUUID()}`;

  return {
    memoryId,
    type: partial.type,
    subtype: partial.subtype || null,
    content: partial.content,
    tags: Array.isArray(partial.tags) ? [...partial.tags] : [],
    provenance: {
      sourceType: partial.provenance?.sourceType || 'operator',
      loopId: partial.provenance?.loopId || null,
      timestamp: partial.provenance?.timestamp || now,
      confidence: typeof partial.provenance?.confidence === 'number' ? partial.provenance.confidence : 1.0,
    },
    freshness: {
      createdAt: partial.freshness?.createdAt || now,
      updatedAt: partial.freshness?.updatedAt || now,
      expiresAt: partial.freshness?.expiresAt || null,
      stale: partial.freshness?.stale || false,
    },
    visibility: partial.visibility || 'private',
    contradictions: Array.isArray(partial.contradictions) ? [...partial.contradictions] : [],
    dedupeKey: partial.dedupeKey || null,
  };
}

// Build an index row from a full entry
function indexRowFor(entry) {
  return {
    memoryId: entry.memoryId,
    type: entry.type,
    subtype: entry.subtype || null,
    dedupeKey: entry.dedupeKey || null,
    tags: Array.isArray(entry.tags) ? [...entry.tags] : [],
    visibility: entry.visibility || 'private',
    stale: entry.freshness ? entry.freshness.stale : false,
    createdAt: entry.freshness ? entry.freshness.createdAt : new Date().toISOString(),
  };
}

class MemoryWeaver {
  /**
   * @param {object} stateStore - state store instance (get/put methods)
   */
  constructor(stateStore) {
    if (!stateStore || typeof stateStore.get !== 'function') {
      throw new Error('MemoryWeaver requires a valid stateStore with get/put methods');
    }
    this._store = stateStore;
  }

  // -------------------------------------------------------------------------
  // Index helpers
  // -------------------------------------------------------------------------

  /** Load the index array from the store. Returns [] if not yet initialized. */
  async _getIndex() {
    const index = await this._store.get('memory-index');
    return Array.isArray(index) ? index : [];
  }

  /** Persist the index array. */
  async _saveIndex(index) {
    await this._store.put('memory-index', index);
  }

  /** Load a single memory entry by memoryId. */
  async _getMemory(memoryId) {
    return this._store.get(`memory:${memoryId}`);
  }

  /** Persist a single memory entry. */
  async _saveMemory(entry) {
    await this._store.put(`memory:${entry.memoryId}`, entry);
  }

  /** Delete a single memory entry from the store. */
  async _deleteMemory(memoryId) {
    if (typeof this._store.delete === 'function') {
      await this._store.delete(`memory:${memoryId}`);
    }
  }

  /** Add (or update) an entry's row in the index. */
  async _addToIndex(entry) {
    const index = await this._getIndex();
    const row = indexRowFor(entry);
    const existing = index.findIndex((r) => r.memoryId === entry.memoryId);
    if (existing >= 0) {
      index[existing] = row;
    } else {
      index.push(row);
    }
    await this._saveIndex(index);
  }

  /** Remove an entry from the index by memoryId. */
  async _removeFromIndex(memoryId) {
    const index = await this._getIndex();
    const next = index.filter((r) => r.memoryId !== memoryId);
    await this._saveIndex(next);
  }

  /** Find the first index row whose dedupeKey matches, or null. */
  async _findIndexRowByDedupeKey(dedupeKey) {
    const index = await this._getIndex();
    return index.find((r) => r.dedupeKey === dedupeKey) || null;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Write a memory entry. Validates, strips secrets, deduplicates by dedupeKey
   * (delete old entry, insert new), persists, returns saved entry with memoryId.
   *
   * @param {object} entry - partial or full memory entry
   * @returns {Promise<object>} stored memory entry
   */
  async write(entry) {
    // Build full entry with defaults
    const built = buildEntry(entry);

    // Strip secrets from content before validation
    built.content = stripSecrets(built.content);

    // Validate
    validateEntry(built);

    // Deduplication by dedupeKey: delete old, insert new (per spec)
    if (built.dedupeKey) {
      const existingRow = await this._findIndexRowByDedupeKey(built.dedupeKey);
      if (existingRow && existingRow.memoryId !== built.memoryId) {
        // Delete the old entry and remove from index
        await this._deleteMemory(existingRow.memoryId);
        await this._removeFromIndex(existingRow.memoryId);
      }
    }

    // Preserve original createdAt if this is an update (same memoryId already stored)
    const existingById = await this._getMemory(built.memoryId);
    if (existingById) {
      built.freshness.createdAt = existingById.freshness.createdAt;
    }

    // Stamp updatedAt
    built.freshness.updatedAt = new Date().toISOString();

    // Persist and index
    await this._saveMemory(built);
    await this._addToIndex(built);

    return { ...built };
  }

  /**
   * Read memories matching optional filters.
   *
   * @param {object} opts - { type?, tags?, limit?, includeStale?, visibility? }
   * @returns {Promise<object[]>} matching memory entries
   */
  async read(opts = {}) {
    const { type, tags, limit, includeStale = false, visibility } = opts;

    const index = await this._getIndex();
    const results = [];

    for (const row of index) {
      // Filter by type
      if (type && row.type !== type) continue;

      // Filter stale
      if (!includeStale && row.stale) continue;

      // Private memories never appear when visibility filter is 'public'
      if (visibility === 'public' && row.visibility === 'private') continue;

      // Filter by tags (all specified tags must be present)
      if (tags && tags.length > 0) {
        const memTags = row.tags || [];
        const hasAll = tags.every((t) => memTags.includes(t));
        if (!hasAll) continue;
      }

      // Load full entry
      const mem = await this._getMemory(row.memoryId);
      if (!mem) continue;

      results.push({ ...mem });
    }

    if (typeof limit === 'number' && limit > 0) {
      return results.slice(0, limit);
    }
    return results;
  }

  /**
   * Shorthand for read({ type, ...opts }).
   *
   * @param {string} type - memory type
   * @param {object} opts - additional read options
   * @returns {Promise<object[]>}
   */
  async readByType(type, opts = {}) {
    return this.read({ ...opts, type });
  }

  /**
   * Get a specific memory by ID.
   *
   * @param {string} memoryId
   * @returns {Promise<object|null>}
   */
  async get(memoryId) {
    const mem = await this._getMemory(memoryId);
    return mem ? { ...mem } : null;
  }

  /**
   * Delete a specific memory by ID. Removes from index and store.
   *
   * @param {string} memoryId
   * @returns {Promise<boolean>} true if deleted, false if not found
   */
  async delete(memoryId) {
    const mem = await this._getMemory(memoryId);
    if (!mem) return false;
    await this._deleteMemory(memoryId);
    await this._removeFromIndex(memoryId);
    return true;
  }

  /**
   * Expire memories where expiresAt < now, or where olderThanDays is set and
   * createdAt is older than that threshold.
   *
   * @param {object} opts - { type?, olderThanDays? }
   * @returns {Promise<number>} count of newly expired memories
   */
  async expire(opts = {}) {
    const { type, olderThanDays } = opts;
    const now = new Date();
    const index = await this._getIndex();
    let count = 0;

    for (const row of index) {
      if (type && row.type !== type) continue;
      if (row.stale) continue; // already stale

      let shouldExpire = false;

      const mem = await this._getMemory(row.memoryId);
      if (!mem) continue;

      // Expire by expiresAt
      if (mem.freshness.expiresAt) {
        const expiresAt = new Date(mem.freshness.expiresAt);
        if (expiresAt < now) shouldExpire = true;
      }

      // Expire by age (use != null so olderThanDays:0 is valid)
      if (!shouldExpire && olderThanDays != null) {
        const createdAt = new Date(mem.freshness.createdAt);
        const ageDays = (now - createdAt) / (1000 * 60 * 60 * 24);
        if (ageDays >= olderThanDays) shouldExpire = true;
      }

      if (shouldExpire) {
        const nowIso = now.toISOString();
        const updated = {
          ...mem,
          freshness: { ...mem.freshness, stale: true, updatedAt: nowIso },
        };
        await this._saveMemory(updated);
        // Update index row
        row.stale = true;
        count++;
      }
    }

    // Persist updated index (stale flags may have changed)
    await this._saveIndex(index);
    return count;
  }

  /**
   * Consolidate memories:
   * 1. Expire all episodic entries past their expiresAt.
   * 2. For episodic entries older than olderThanDays that share the same tags,
   *    keep the newest only; mark the rest stale.
   *
   * @param {object} opts - { olderThanDays? }
   * @returns {Promise<{ merged: number, expired: number }>}
   */
  async consolidate(opts = {}) {
    const { olderThanDays = 30 } = opts;
    const now = new Date();

    // Step 1: expire anything past expiresAt for episodic type
    const expired = await this.expire({ type: 'episodic' });

    // Step 2: find non-stale episodic memories older than olderThanDays
    const episodics = await this.readByType('episodic', { includeStale: false });
    const old = episodics.filter((m) => {
      const createdAt = new Date(m.freshness.createdAt);
      const ageDays = (now - createdAt) / (1000 * 60 * 60 * 24);
      return ageDays > olderThanDays;
    });

    if (old.length === 0) {
      return { merged: 0, expired };
    }

    // Group by sorted tags string (same tags = same group)
    const byTags = {};
    for (const mem of old) {
      const key = (mem.tags || []).slice().sort().join('\x00');
      if (!byTags[key]) byTags[key] = [];
      byTags[key].push(mem);
    }

    let merged = 0;
    const nowIso = now.toISOString();
    const index = await this._getIndex();

    for (const mems of Object.values(byTags)) {
      if (mems.length < 2) continue;

      // Sort by createdAt ascending; newest is last
      mems.sort((a, b) => new Date(a.freshness.createdAt) - new Date(b.freshness.createdAt));

      const newest = mems[mems.length - 1];
      const toRemove = mems.slice(0, mems.length - 1);

      // Mark all but the newest as stale
      for (const mem of toRemove) {
        const updated = {
          ...mem,
          freshness: { ...mem.freshness, stale: true, updatedAt: nowIso },
        };
        await this._saveMemory(updated);
        const row = index.find((r) => r.memoryId === mem.memoryId);
        if (row) row.stale = true;
        merged++;
      }
    }

    if (merged > 0) {
      await this._saveIndex(index);
    }

    return { merged, expired };
  }

  /**
   * Detect contradictions between a new entry and existing stored memories.
   * Simple check: same type + same subtype + same dedupeKey but different content.
   *
   * @param {object} newEntry - candidate memory entry (not yet stored)
   * @returns {Promise<{ existingId: string, description: string }[]>}
   */
  async detectContradictions(newEntry) {
    if (!newEntry || !newEntry.type) return [];
    if (!newEntry.dedupeKey) return [];

    const existing = await this.readByType(newEntry.type, { includeStale: false });
    const contradictions = [];

    for (const mem of existing) {
      // Must share dedupeKey
      if (!mem.dedupeKey || mem.dedupeKey !== newEntry.dedupeKey) continue;

      // Must match subtype if both are specified
      if (newEntry.subtype && mem.subtype && mem.subtype !== newEntry.subtype) continue;

      // Check for content difference
      const newContentStr = JSON.stringify(stripSecrets(newEntry.content));
      const memContentStr = JSON.stringify(mem.content);

      if (newContentStr !== memContentStr) {
        contradictions.push({
          existingId: mem.memoryId,
          description: `Memory "${mem.memoryId}" shares dedupeKey "${newEntry.dedupeKey}" but has different content`,
        });
      }
    }

    return contradictions;
  }

  /**
   * Scan index; for each dedupeKey, keep newest (by updatedAt), delete rest.
   *
   * @returns {Promise<number>} count of duplicates removed
   */
  async deduplicate() {
    const index = await this._getIndex();
    const byDedupeKey = {};

    for (const row of index) {
      if (!row.dedupeKey) continue;
      if (!byDedupeKey[row.dedupeKey]) byDedupeKey[row.dedupeKey] = [];
      byDedupeKey[row.dedupeKey].push(row);
    }

    let removed = 0;

    for (const rows of Object.values(byDedupeKey)) {
      if (rows.length <= 1) continue;

      // Load full entries to compare updatedAt
      const mems = await Promise.all(rows.map((r) => this._getMemory(r.memoryId)));
      const valid = mems.filter(Boolean);

      if (valid.length <= 1) continue;

      // Sort by updatedAt descending; keep the newest
      valid.sort(
        (a, b) => new Date(b.freshness.updatedAt) - new Date(a.freshness.updatedAt)
      );

      const [_keep, ...stale] = valid;

      for (const dup of stale) {
        await this._deleteMemory(dup.memoryId);
        await this._removeFromIndex(dup.memoryId);
        removed++;
      }
    }

    return removed;
  }

  /**
   * Validate memory health and return diagnostics.
   *
   * @param {object} opts - { type?, subtype? }
   * @returns {Promise<{ staleCount: number, provenanceGaps: number, contradictionCount: number }>}
   */
  async lint(opts = {}) {
    const { type, subtype } = opts;
    const index = await this._getIndex();

    let staleCount = 0;
    let provenanceGaps = 0;
    let contradictionCount = 0;

    for (const row of index) {
      if (type && row.type !== type) continue;
      if (subtype !== undefined && row.subtype !== subtype) continue;

      if (row.stale) staleCount++;

      // Load full entry for provenance and contradiction checks
      const mem = await this._getMemory(row.memoryId);
      if (!mem) continue;

      // Provenance gap: missing sourceType or confidence not set
      if (!mem.provenance || !mem.provenance.sourceType ||
          typeof mem.provenance.confidence !== 'number') {
        provenanceGaps++;
      }

      // Count recorded contradictions
      if (Array.isArray(mem.contradictions) && mem.contradictions.length > 0) {
        contradictionCount += mem.contradictions.length;
      }
    }

    return { staleCount, provenanceGaps, contradictionCount };
  }
}

module.exports = { MemoryWeaver };
