// zictionary.js - Sourced glossary for ZOL Persistent Agent Upgrade v2
// Provides a Trapper-style editable glossary with aliases, definitions, citations,
// relationship graphs, history, and approval workflow.
//
// EDITORIAL PRINCIPLE: All entries are source-grounded. Generated definitions are
// derived material — they are never authoritative truth. Zaal must be able to add,
// edit, reject, import, export, and reorganize all entries.
//
// Persistence keys:
//   "zictionary-index"        - array of {entryId, term, aliases, status, tags, visibility, createdAt, updatedAt}
//   "zictionary:{entryId}"    - full entry object

'use strict';

const crypto = require('crypto');

// Secret patterns to strip from definitions and citations before storage
const SECRET_PATTERNS = [
  /[0-9a-fA-F]{64}/g,
  /sk-[a-zA-Z0-9_-]+/g,
  /ghp_[a-zA-Z0-9_-]+/g,
];

function stripSecrets(value) {
  if (typeof value === 'string') {
    let result = value;
    for (const pattern of SECRET_PATTERNS) {
      pattern.lastIndex = 0;
      result = result.replace(pattern, '[REDACTED]');
    }
    return result;
  }
  if (Array.isArray(value)) return value.map(stripSecrets);
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = stripSecrets(v);
    return out;
  }
  return value;
}

const VALID_STATUSES = ['draft', 'approved', 'rejected'];
const VALID_VISIBILITIES = ['private', 'public'];
const VALID_RELATIONS = ['synonym', 'antonym', 'broader', 'narrower', 'related'];

const INDEX_KEY = 'zictionary-index';

class Zictionary {
  /**
   * @param {object} stateStore - A state-adapter store instance (get/put interface).
   */
  constructor(stateStore) {
    if (!stateStore) throw new Error('Zictionary requires a stateStore');
    this.stateStore = stateStore;
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  async _loadIndex() {
    const index = await this.stateStore.get(INDEX_KEY);
    return index || [];
  }

  async _saveIndex(index) {
    await this.stateStore.put(INDEX_KEY, index);
  }

  async _loadEntry(entryId) {
    return this.stateStore.get('zictionary:' + entryId);
  }

  async _saveEntry(entry) {
    await this.stateStore.put('zictionary:' + entry.entryId, entry);
  }

  /** Update the index stub for an entry (upsert by entryId). */
  async _updateIndex(entry) {
    const index = await this._loadIndex();
    const stub = {
      entryId: entry.entryId,
      term: entry.term,
      aliases: entry.aliases,
      status: entry.status,
      tags: entry.tags,
      visibility: entry.visibility,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
    };
    const idx = index.findIndex((s) => s.entryId === entry.entryId);
    if (idx === -1) {
      index.push(stub);
    } else {
      index[idx] = stub;
    }
    await this._saveIndex(index);
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * add({ term, definition, aliases, citations, tags, visibility })
   * Creates a new draft entry. status is always 'draft' on creation.
   * @returns {object} The created entry.
   */
  async add({ term, definition, aliases = [], citations = [], tags = [], visibility = 'private' } = {}) {
    if (!term || typeof term !== 'string') throw new Error('Zictionary.add: term is required');
    if (!definition || typeof definition !== 'string') throw new Error('Zictionary.add: definition is required');
    if (!VALID_VISIBILITIES.includes(visibility)) {
      throw new Error(`Zictionary.add: visibility must be one of: ${VALID_VISIBILITIES.join(', ')}`);
    }

    const now = new Date().toISOString();
    const entryId = 'zdic_' + crypto.randomUUID();

    const entry = stripSecrets({
      entryId,
      term,
      aliases: Array.isArray(aliases) ? aliases : [],
      definition,
      citations: Array.isArray(citations) ? citations : [],
      relationships: [],
      history: [{ at: now, change: 'Entry created', changedBy: 'system' }],
      approvedBy: null,
      status: 'draft',
      createdAt: now,
      updatedAt: now,
      tags: Array.isArray(tags) ? tags : [],
      visibility,
    });

    await this._saveEntry(entry);
    await this._updateIndex(entry);
    return { ...entry };
  }

  /**
   * edit(entryId, changes)
   * Apply changes to an entry and append a history record.
   * @returns {object} The updated entry.
   */
  async edit(entryId, changes = {}) {
    if (!entryId) throw new Error('Zictionary.edit: entryId is required');
    const entry = await this._loadEntry(entryId);
    if (!entry) throw new Error(`Zictionary.edit: entry not found: ${entryId}`);

    // Immutable fields that cannot be overridden via edit()
    const immutable = new Set(['entryId', 'createdAt', 'history', 'relationships', 'citations']);
    const allowed = {};
    for (const [k, v] of Object.entries(changes)) {
      if (!immutable.has(k)) allowed[k] = v;
    }

    if (allowed.visibility && !VALID_VISIBILITIES.includes(allowed.visibility)) {
      throw new Error(`Zictionary.edit: visibility must be one of: ${VALID_VISIBILITIES.join(', ')}`);
    }
    if (allowed.status === 'approved') {
      throw new Error('Zictionary.edit: cannot set status=approved via edit(); use approve() with verified authority.');
    }
    if (allowed.status && !VALID_STATUSES.includes(allowed.status)) {
      throw new Error(`Zictionary.edit: status must be one of: ${VALID_STATUSES.join(', ')}`);
    }

    const now = new Date().toISOString();
    const changedFields = Object.keys(allowed).join(', ');

    // Any edit on an approved entry invalidates approval and returns it to draft.
    // Re-approval requires a fresh call to approve() with verified authority.
    const wasApproved = entry.status === 'approved';
    if (wasApproved) {
      allowed.status = 'draft';
      allowed.approvedBy = null;
    }

    const updated = stripSecrets({
      ...entry,
      ...allowed,
      updatedAt: now,
      history: [
        ...entry.history,
        {
          at: now,
          change: wasApproved
            ? `Fields edited: ${changedFields || 'none'} (approval invalidated — returned to draft)`
            : `Fields edited: ${changedFields || 'none'}`,
          changedBy: changes.changedBy || 'operator',
        },
      ],
    });

    await this._saveEntry(updated);
    await this._updateIndex(updated);
    return { ...updated };
  }

  /**
   * approve(entryId, { approvedBy })
   * Sets status to 'approved'. approvedBy defaults to 'zaal'.
   * @returns {object} The updated entry.
   */
  async approve(entryId, { approvedBy = 'zaal' } = {}) {
    if (!entryId) throw new Error('Zictionary.approve: entryId is required');
    const entry = await this._loadEntry(entryId);
    if (!entry) throw new Error(`Zictionary.approve: entry not found: ${entryId}`);

    const now = new Date().toISOString();
    const updated = {
      ...entry,
      status: 'approved',
      approvedBy,
      updatedAt: now,
      history: [...entry.history, { at: now, change: `Approved by ${approvedBy}`, changedBy: approvedBy }],
    };

    await this._saveEntry(updated);
    await this._updateIndex(updated);
    return { ...updated };
  }

  /**
   * reject(entryId, reason)
   * Sets status to 'rejected' and records the reason in history.
   * @returns {object} The updated entry.
   */
  async reject(entryId, reason = '') {
    if (!entryId) throw new Error('Zictionary.reject: entryId is required');
    const entry = await this._loadEntry(entryId);
    if (!entry) throw new Error(`Zictionary.reject: entry not found: ${entryId}`);

    const now = new Date().toISOString();
    const updated = {
      ...entry,
      status: 'rejected',
      updatedAt: now,
      history: [
        ...entry.history,
        { at: now, change: `Rejected${reason ? ': ' + reason : ''}`, changedBy: 'operator' },
      ],
    };

    await this._saveEntry(updated);
    await this._updateIndex(updated);
    return { ...updated };
  }

  /**
   * get(entryId)
   * @returns {object|null}
   */
  async get(entryId) {
    if (!entryId) return null;
    const entry = await this._loadEntry(entryId);
    return entry ? { ...entry } : null;
  }

  /**
   * findByTerm(term)
   * Case-insensitive search across term and all aliases.
   * Returns the first match or null.
   * @returns {object|null}
   */
  async findByTerm(term) {
    if (!term) return null;
    const needle = term.toLowerCase();
    const index = await this._loadIndex();
    const matched = index.filter((stub) => {
      if (stub.term.toLowerCase() === needle) return true;
      return stub.aliases.some((a) => a.toLowerCase() === needle);
    });
    if (matched.length === 0) return null;
    const entry = await this._loadEntry(matched[0].entryId);
    return entry ? { ...entry } : null;
  }

  /**
   * list({ status, tags, limit })
   * Return filtered entries from the index. Loads full entries.
   * @returns {object[]}
   */
  async list({ status, tags, limit = 50 } = {}) {
    const index = await this._loadIndex();
    let stubs = index;

    if (status) stubs = stubs.filter((s) => s.status === status);
    if (tags && tags.length > 0) {
      stubs = stubs.filter((s) => tags.every((t) => s.tags.includes(t)));
    }

    stubs = stubs.slice(0, limit);
    const results = [];
    for (const stub of stubs) {
      const entry = await this._loadEntry(stub.entryId);
      if (entry) results.push({ ...entry });
    }
    return results;
  }

  /**
   * addRelationship(entryId, rel)
   * Appends a relationship to an entry's relationship array.
   * Accepts { targetTerm, type, confidence } or legacy { relatedTerm, relation, confidence }.
   * @returns {object} The updated entry.
   */
  async addRelationship(entryId, rel = {}) {
    if (!entryId) throw new Error('Zictionary.addRelationship: entryId is required');

    // Normalise: accept both {targetTerm, type} and legacy {relatedTerm, relation}
    const targetTerm = rel.targetTerm || rel.relatedTerm;
    const relationType = rel.type || rel.relation;
    const confidence = typeof rel.confidence === 'number' ? rel.confidence : 0.8;

    if (!targetTerm) throw new Error('Zictionary.addRelationship: targetTerm (or relatedTerm) is required');
    if (relationType && !VALID_RELATIONS.includes(relationType)) {
      throw new Error(`Zictionary.addRelationship: type/relation must be one of: ${VALID_RELATIONS.join(', ')}`);
    }
    if (confidence < 0 || confidence > 1) {
      throw new Error('Zictionary.addRelationship: confidence must be a number between 0.0 and 1.0');
    }

    const entry = await this._loadEntry(entryId);
    if (!entry) throw new Error(`Zictionary.addRelationship: entry not found: ${entryId}`);

    const now = new Date().toISOString();
    const relationship = { targetTerm, type: relationType || 'related', confidence };
    const updated = {
      ...entry,
      relationships: [...entry.relationships, relationship],
      updatedAt: now,
      history: [
        ...entry.history,
        { at: now, change: `Relationship added: ${relationship.type} → ${targetTerm}`, changedBy: 'operator' },
      ],
    };

    await this._saveEntry(updated);
    await this._updateIndex(updated);
    return { ...updated };
  }

  /**
   * export()
   * Returns all approved entries as a plain array.
   * @returns {object[]}
   */
  async export() {
    return this.list({ status: 'approved', limit: Number.MAX_SAFE_INTEGER });
  }

  /**
   * import(entries)
   * Bulk-import an array of entries. All imported entries are set to status='draft'.
   * Assigns new entryIds so imports never collide with existing entries.
   * @returns {number} Count of imported entries.
   */
  async import(entries) {
    if (!Array.isArray(entries)) throw new Error('Zictionary.import: entries must be an array');
    let count = 0;
    for (const raw of entries) {
      const now = new Date().toISOString();
      const entryId = 'zdic_' + crypto.randomUUID();
      const entry = stripSecrets({
        ...raw,
        entryId,
        status: 'draft',
        approvedBy: null,
        createdAt: raw.createdAt || now,
        updatedAt: now,
        history: [
          ...(Array.isArray(raw.history) ? raw.history : []),
          { at: now, change: 'Imported (status reset to draft)', changedBy: 'system' },
        ],
        relationships: Array.isArray(raw.relationships) ? raw.relationships : [],
        citations: Array.isArray(raw.citations) ? raw.citations : [],
        aliases: Array.isArray(raw.aliases) ? raw.aliases : [],
        tags: Array.isArray(raw.tags) ? raw.tags : [],
        visibility: VALID_VISIBILITIES.includes(raw.visibility) ? raw.visibility : 'private',
      });
      await this._saveEntry(entry);
      await this._updateIndex(entry);
      count++;
    }
    return count;
  }
}

module.exports = { Zictionary };
