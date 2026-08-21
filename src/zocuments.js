// zocuments.js - Document store for ZOL Persistent Agent Upgrade v2
// Manages documents, transcripts, PDFs, links, notes, and data blobs with
// content hashing, permissions, source metadata, and annotation support.
//
// EDITORIAL PRINCIPLE: All documents are source-grounded primary material.
// Zaal must be able to add, edit, reject, import, export, and reorganize all documents.
// Secrets are stripped from content before storage.
//
// Persistence keys:
//   "zocuments-index"         - array of {docId, title, type, status, permissions, tags, createdAt, updatedAt}
//   "zocument:{docId}"        - full document object

'use strict';

const crypto = require('crypto');

// Secret patterns that must be stripped from content before storage
const SECRET_PATTERNS = [
  /[0-9a-fA-F]{64}/g,
  /sk-[a-zA-Z0-9_-]+/g,
  /ghp_[a-zA-Z0-9_-]+/g,
  /PRIVATE\s*KEY/gi,
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

/**
 * Compute a SHA-256 hex hash of a string (typically document content).
 */
function sha256(content) {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

const VALID_TYPES = ['document', 'transcript', 'pdf', 'link', 'note', 'data', 'other', 'article'];
const VALID_STATUSES = ['draft', 'approved', 'rejected'];
const VALID_PERMISSIONS = ['private', 'shared', 'public'];

const INDEX_KEY = 'zocuments-index';

class Zocuments {
  /**
   * @param {object} stateStore - A state-adapter store instance (get/put interface).
   */
  constructor(stateStore) {
    if (!stateStore) throw new Error('Zocuments requires a stateStore');
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

  async _loadDoc(docId) {
    return this.stateStore.get('zocument:' + docId);
  }

  async _saveDoc(doc) {
    await this.stateStore.put('zocument:' + doc.docId, doc);
  }

  /** Upsert the index stub for a document. */
  async _updateIndex(doc) {
    const index = await this._loadIndex();
    const stub = {
      docId: doc.docId,
      title: doc.title,
      type: doc.type,
      status: doc.status,
      permissions: doc.permissions,
      tags: doc.tags,
      createdAt: doc.createdAt,
      updatedAt: doc.updatedAt,
    };
    const idx = index.findIndex((s) => s.docId === doc.docId);
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
   * add({ title, type, content, sourceUrl, sourceName, tags, permissions })
   * Creates a new draft document. Computes contentHash. Strips secrets from content.
   * @returns {object} The created document.
   */
  async add({
    title,
    type,
    content,
    sourceUrl = null,
    sourceName = null,
    tags = [],
    permissions = 'private',
  } = {}) {
    if (!title || typeof title !== 'string') throw new Error('Zocuments.add: title is required');
    if (!VALID_TYPES.includes(type)) {
      throw new Error(`Zocuments.add: type must be one of: ${VALID_TYPES.join(', ')}`);
    }
    if (content === undefined || content === null) throw new Error('Zocuments.add: content is required');
    if (!VALID_PERMISSIONS.includes(permissions)) {
      throw new Error(`Zocuments.add: permissions must be one of: ${VALID_PERMISSIONS.join(', ')}`);
    }

    const cleanContent = stripSecrets(String(content));
    const now = new Date().toISOString();
    const docId = 'zdoc_' + crypto.randomUUID();

    const doc = {
      docId,
      title: stripSecrets(title),
      type,
      content: cleanContent,
      contentHash: sha256(cleanContent),
      sourceUrl: sourceUrl ? stripSecrets(sourceUrl) : null,
      sourceName: sourceName ? stripSecrets(sourceName) : null,
      fetchedAt: null,
      permissions,
      tags: Array.isArray(tags) ? tags : [],
      notes: '',
      changeLog: [],
      approvedBy: null,
      status: 'draft',
      createdAt: now,
      updatedAt: now,
      zikipediaIds: [],
    };

    await this._saveDoc(doc);
    await this._updateIndex(doc);
    return { ...doc };
  }

  /**
   * edit(docId, changes)
   * Apply changes to a document. If content changes, recomputes contentHash.
   * Secrets are stripped from any updated content.
   * @returns {object} The updated document.
   */
  async edit(docId, changes = {}) {
    if (!docId) throw new Error('Zocuments.edit: docId is required');
    const doc = await this._loadDoc(docId);
    if (!doc) throw new Error(`Zocuments.edit: document not found: ${docId}`);

    const immutable = new Set(['docId', 'createdAt', 'contentHash']);
    const allowed = {};
    for (const [k, v] of Object.entries(changes)) {
      if (!immutable.has(k)) allowed[k] = v;
    }

    if (allowed.type && !VALID_TYPES.includes(allowed.type)) {
      throw new Error(`Zocuments.edit: type must be one of: ${VALID_TYPES.join(', ')}`);
    }
    if (allowed.permissions && !VALID_PERMISSIONS.includes(allowed.permissions)) {
      throw new Error(`Zocuments.edit: permissions must be one of: ${VALID_PERMISSIONS.join(', ')}`);
    }
    if (allowed.status && !VALID_STATUSES.includes(allowed.status)) {
      throw new Error(`Zocuments.edit: status must be one of: ${VALID_STATUSES.join(', ')}`);
    }

    const now = new Date().toISOString();
    const changedFields = Object.keys(allowed).join(', ');
    const changeEntry = { at: now, fields: changedFields || 'none', changedBy: changes.changedBy || 'operator' };
    const merged = {
      ...doc,
      ...allowed,
      updatedAt: now,
      changeLog: [...(doc.changeLog || []), changeEntry],
    };

    // Recompute hash if content was changed; strip secrets from new content
    if (allowed.content !== undefined) {
      merged.content = stripSecrets(String(allowed.content));
      merged.contentHash = sha256(merged.content);
    }

    // Strip secrets from other string fields that may have been updated
    if (allowed.title !== undefined) merged.title = stripSecrets(merged.title);
    if (allowed.sourceUrl !== undefined) merged.sourceUrl = merged.sourceUrl ? stripSecrets(merged.sourceUrl) : null;
    if (allowed.sourceName !== undefined)
      merged.sourceName = merged.sourceName ? stripSecrets(merged.sourceName) : null;
    if (allowed.notes !== undefined) merged.notes = stripSecrets(merged.notes);

    await this._saveDoc(merged);
    await this._updateIndex(merged);
    return { ...merged };
  }

  /**
   * approve(docId, { approvedBy })
   * Sets status to 'approved'. approvedBy defaults to 'zaal'.
   * @returns {object} The updated document.
   */
  async approve(docId, { approvedBy = 'zaal' } = {}) {
    if (!docId) throw new Error('Zocuments.approve: docId is required');
    const doc = await this._loadDoc(docId);
    if (!doc) throw new Error(`Zocuments.approve: document not found: ${docId}`);

    const now = new Date().toISOString();
    const updated = { ...doc, status: 'approved', approvedBy, updatedAt: now };

    await this._saveDoc(updated);
    await this._updateIndex(updated);
    return { ...updated };
  }

  /**
   * reject(docId, reason)
   * Sets status to 'rejected'.
   * @returns {object} The updated document.
   */
  async reject(docId, reason = '') {
    if (!docId) throw new Error('Zocuments.reject: docId is required');
    const doc = await this._loadDoc(docId);
    if (!doc) throw new Error(`Zocuments.reject: document not found: ${docId}`);

    const now = new Date().toISOString();
    const updated = {
      ...doc,
      status: 'rejected',
      notes: doc.notes
        ? `${doc.notes}\n[Rejected: ${reason}]`
        : `[Rejected: ${reason}]`,
      updatedAt: now,
    };

    await this._saveDoc(updated);
    await this._updateIndex(updated);
    return { ...updated };
  }

  /**
   * get(docId)
   * @returns {object|null}
   */
  async get(docId) {
    if (!docId) return null;
    const doc = await this._loadDoc(docId);
    return doc ? { ...doc } : null;
  }

  /**
   * search(query)
   * Case-insensitive search across title and content. Returns full document objects.
   * @returns {object[]}
   */
  async search(query) {
    if (!query) return [];
    const needle = query.toLowerCase();
    const index = await this._loadIndex();
    const results = [];
    for (const stub of index) {
      if (stub.title.toLowerCase().includes(needle)) {
        const doc = await this._loadDoc(stub.docId);
        if (doc) {
          results.push({ ...doc });
          continue;
        }
      }
      const doc = await this._loadDoc(stub.docId);
      if (doc && doc.content.toLowerCase().includes(needle)) {
        results.push({ ...doc });
      }
    }
    return results;
  }

  /**
   * list({ type, status, tags, limit })
   * Return filtered documents.
   * @returns {object[]}
   */
  async list({ type, status, tags, limit = 50 } = {}) {
    const index = await this._loadIndex();
    let stubs = index;

    if (type) stubs = stubs.filter((s) => s.type === type);
    if (status) stubs = stubs.filter((s) => s.status === status);
    if (tags && tags.length > 0) {
      stubs = stubs.filter((s) => tags.every((t) => s.tags.includes(t)));
    }

    stubs = stubs.slice(0, limit);
    const results = [];
    for (const stub of stubs) {
      const doc = await this._loadDoc(stub.docId);
      if (doc) results.push({ ...doc });
    }
    return results;
  }

  /**
   * export({ permissions })
   * Returns only documents where doc.permissions === permissions.
   * Defaults to 'public'.
   * @returns {object[]}
   */
  async export({ permissions = 'public' } = {}) {
    const all = await this.list({ limit: Number.MAX_SAFE_INTEGER });
    return all.filter((doc) => doc.permissions === permissions);
  }

  /**
   * import(docs)
   * Bulk-import documents. All imported docs are set to status='draft'.
   * Secrets are stripped. New docIds are assigned to avoid collisions.
   * @returns {object[]} Array of imported document objects.
   */
  async import(docs) {
    if (!Array.isArray(docs)) throw new Error('Zocuments.import: docs must be an array');
    const imported = [];
    for (const raw of docs) {
      const now = new Date().toISOString();
      const docId = 'zdoc_' + crypto.randomUUID();
      const cleanContent = stripSecrets(String(raw.content || ''));
      const doc = {
        ...raw,
        docId,
        content: cleanContent,
        contentHash: sha256(cleanContent),
        title: stripSecrets(String(raw.title || '')),
        sourceUrl: raw.sourceUrl ? stripSecrets(raw.sourceUrl) : null,
        sourceName: raw.sourceName ? stripSecrets(raw.sourceName) : null,
        notes: raw.notes ? stripSecrets(raw.notes) : '',
        changeLog: [],
        status: 'draft',
        approvedBy: null,
        createdAt: raw.createdAt || now,
        updatedAt: now,
        tags: Array.isArray(raw.tags) ? raw.tags : [],
        zikipediaIds: Array.isArray(raw.zikipediaIds) ? raw.zikipediaIds : [],
        permissions: VALID_PERMISSIONS.includes(raw.permissions) ? raw.permissions : 'private',
        type: VALID_TYPES.includes(raw.type) ? raw.type : 'other',
        fetchedAt: raw.fetchedAt || null,
      };
      await this._saveDoc(doc);
      await this._updateIndex(doc);
      imported.push({ ...doc });
    }
    return imported;
  }
}

module.exports = { Zocuments };
