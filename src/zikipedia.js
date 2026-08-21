// zikipedia.js - Linked living wiki for ZOL Persistent Agent Upgrade v2
// Pages are generated ONLY from approved Zocuments and approved Zictionary entries.
//
// EDITORIAL PRINCIPLE: This is a Trapper-style editable knowledge surface.
// - The `summary` field is DERIVED MATERIAL — it is not authoritative truth.
//   It should always be labeled as such in any UI or downstream rendering.
// - Zaal must be able to create, edit, reject, import, export, and reorganize all pages.
// - Pages are never auto-published: they require explicit approval (status='approved').
//
// Persistence keys:
//   "zikipedia-index"         - array of {pageId, title, slug, status, tags, createdAt, updatedAt}
//   "zikipedia:{pageId}"      - full page object

'use strict';

const crypto = require('crypto');

// DERIVED MATERIAL NOTE: The `summary` field on every wiki page is generated
// (AI-assisted or operator-written) and is NOT authoritative truth. It is clearly
// labeled here so any consumer of Zikipedia pages treats summaries as contextual
// aids, not primary sources. Always cite the underlying Zocuments for authoritative claims.

const VALID_STATUSES = ['draft', 'approved', 'rejected'];

const INDEX_KEY = 'zikipedia-index';

// Regex to extract [[WikiLinks]] from page content
const WIKI_LINK_PATTERN = /\[\[([^\]]+)\]\]/g;

class Zikipedia {
  /**
   * @param {object} stateStore   - A state-adapter store instance (get/put interface).
   * @param {object} zocuments    - A Zocuments instance (for source validation).
   * @param {object} zictionary   - A Zictionary instance (for term validation).
   */
  constructor(stateStore, zocuments, zictionary) {
    if (!stateStore) throw new Error('Zikipedia requires a stateStore');
    if (!zocuments) throw new Error('Zikipedia requires a zocuments instance');
    if (!zictionary) throw new Error('Zikipedia requires a zictionary instance');
    this.stateStore = stateStore;
    this.zocuments = zocuments;
    this.zictionary = zictionary;
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

  async _loadPage(pageId) {
    return this.stateStore.get('zikipedia:' + pageId);
  }

  async _savePage(page) {
    await this.stateStore.put('zikipedia:' + page.pageId, page);
  }

  /** Upsert the index stub for a page. */
  async _updateIndex(page) {
    const index = await this._loadIndex();
    const stub = {
      pageId: page.pageId,
      title: page.title,
      slug: page.slug,
      status: page.status,
      tags: page.tags,
      createdAt: page.createdAt,
      updatedAt: page.updatedAt,
    };
    const idx = index.findIndex((s) => s.pageId === page.pageId);
    if (idx === -1) {
      index.push(stub);
    } else {
      index[idx] = stub;
    }
    await this._saveIndex(index);
  }

  /**
   * Extract all [[WikiLink]] targets from wiki-markup content.
   * Returns an array of slug strings (lowercased, hyphenated).
   */
  _extractLinkedSlugs(content) {
    const slugs = [];
    let match;
    WIKI_LINK_PATTERN.lastIndex = 0;
    while ((match = WIKI_LINK_PATTERN.exec(content)) !== null) {
      slugs.push(this.generateSlug(match[1]));
    }
    return [...new Set(slugs)]; // deduplicate
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * generateSlug(title)
   * Lowercase, replace spaces with hyphens, remove non-alphanumeric except hyphens.
   * @returns {string}
   */
  generateSlug(title) {
    return String(title)
      .toLowerCase()
      .replace(/\s+/g, '-')
      .replace(/[^a-z0-9-]/g, '')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');
  }

  /**
   * create({ title, content, summary, sources, dictionaryTerms, tags })
   * Creates a new draft wiki page. Validates that all sources are approved Zocuments
   * and all dictionaryTerms are approved Zictionary entries.
   * Extracts [[WikiLinks]] from content to populate linkedPages slugs.
   *
   * NOTE: summary is DERIVED MATERIAL — not authoritative. See module header.
   *
   * @returns {object} The created page (status='draft').
   */
  async create({ title, content, summary = '', sources = [], sourceDocId, dictionaryTerms = [], tags = [] } = {}) {
    if (!title || typeof title !== 'string') throw new Error('Zikipedia.create: title is required');

    // Accept sourceDocId shorthand — adds to sources list
    if (sourceDocId) {
      sources = [sourceDocId, ...sources];
    }

    const pageContent = content || '';

    // Validate all sources are approved Zocuments
    for (const src of sources) {
      const docId = typeof src === 'string' ? src : src.docId;
      if (!docId) throw new Error('Zikipedia.create: each source must have a docId');
      const doc = await this.zocuments.get(docId);
      if (!doc) throw new Error(`Zikipedia.create: source document not found: ${docId}`);
      if (doc.status !== 'approved') {
        throw new Error(
          `Zikipedia.create: source document "${docId}" is not approved (status: ${doc.status}). ` +
            'Only approved Zocuments may be cited in Zikipedia pages.'
        );
      }
    }

    // Validate all dictionaryTerms are approved Zictionary entries
    for (const termId of dictionaryTerms) {
      const entry = await this.zictionary.get(termId);
      if (!entry) throw new Error(`Zikipedia.create: dictionary term not found: ${termId}`);
      if (entry.status !== 'approved') {
        throw new Error(
          `Zikipedia.create: dictionary term "${termId}" is not approved (status: ${entry.status}). ` +
            'Only approved Zictionary entries may be referenced in Zikipedia pages.'
        );
      }
    }

    // Normalise sources into { docId, title, quote } shape
    const normalisedSources = [];
    for (const src of sources) {
      if (typeof src === 'string') {
        const doc = await this.zocuments.get(src);
        normalisedSources.push({ docId: src, title: doc ? doc.title : src, quote: null });
      } else {
        normalisedSources.push({
          docId: src.docId,
          title: src.title || '',
          quote: src.quote || null,
        });
      }
    }

    const now = new Date().toISOString();
    const pageId = 'zwiki_' + crypto.randomUUID();
    const slug = this.generateSlug(title);

    // Extract [[links]] to populate linkedPages (as slugs; resolved to pageIds on linkPages())
    const linkedSlugs = this._extractLinkedSlugs(pageContent);

    const page = {
      pageId,
      title,
      slug,
      content: pageContent,
      // DERIVED MATERIAL: summary is AI/operator-generated and NOT authoritative truth.
      // Always prefer citing the underlying sources for factual claims.
      summary: String(summary),
      sources: normalisedSources,
      dictionaryTerms: Array.isArray(dictionaryTerms) ? [...dictionaryTerms] : [],
      status: 'draft',
      generatedFrom: normalisedSources.map((s) => s.docId),
      approvedBy: null,
      createdAt: now,
      updatedAt: now,
      tags: Array.isArray(tags) ? [...tags] : [],
      // linkedPages starts as the slugs extracted from [[links]];
      // use linkPages() to associate resolved pageIds.
      linkedPages: linkedSlugs,
    };

    await this._savePage(page);
    await this._updateIndex(page);
    return { ...page };
  }

  /**
   * edit(pageId, changes)
   * Apply changes to a page. Does NOT re-validate sources on edit —
   * the operator is responsible for maintaining source integrity after editing.
   * If content changes, re-extracts [[WikiLinks]].
   * @returns {object} The updated page.
   */
  async edit(pageId, changes = {}) {
    if (!pageId) throw new Error('Zikipedia.edit: pageId is required');
    const page = await this._loadPage(pageId);
    if (!page) throw new Error(`Zikipedia.edit: page not found: ${pageId}`);

    const immutable = new Set(['pageId', 'createdAt']);
    const allowed = {};
    for (const [k, v] of Object.entries(changes)) {
      if (!immutable.has(k)) allowed[k] = v;
    }

    if (allowed.status && !VALID_STATUSES.includes(allowed.status)) {
      throw new Error(`Zikipedia.edit: status must be one of: ${VALID_STATUSES.join(', ')}`);
    }

    const now = new Date().toISOString();
    const merged = { ...page, ...allowed, updatedAt: now };

    // Re-derive slug if title changed
    if (allowed.title) {
      merged.slug = this.generateSlug(allowed.title);
    }

    // Re-extract [[links]] if content changed
    if (allowed.content) {
      merged.linkedPages = this._extractLinkedSlugs(allowed.content);
    }

    await this._savePage(merged);
    await this._updateIndex(merged);
    return { ...merged };
  }

  /**
   * approve(pageId, { approvedBy })
   * Sets status to 'approved'. approvedBy defaults to 'zaal'.
   * @returns {object} The updated page.
   */
  async approve(pageId, { approvedBy = 'zaal' } = {}) {
    if (!pageId) throw new Error('Zikipedia.approve: pageId is required');
    const page = await this._loadPage(pageId);
    if (!page) throw new Error(`Zikipedia.approve: page not found: ${pageId}`);

    const now = new Date().toISOString();
    const updated = { ...page, status: 'approved', approvedBy, updatedAt: now };

    await this._savePage(updated);
    await this._updateIndex(updated);
    return { ...updated };
  }

  /**
   * reject(pageId, reason)
   * Sets status to 'rejected'.
   * @returns {object} The updated page.
   */
  async reject(pageId, reason = '') {
    if (!pageId) throw new Error('Zikipedia.reject: pageId is required');
    const page = await this._loadPage(pageId);
    if (!page) throw new Error(`Zikipedia.reject: page not found: ${pageId}`);

    const now = new Date().toISOString();
    const updated = {
      ...page,
      status: 'rejected',
      updatedAt: now,
    };

    // Record rejection reason in summary (marked clearly as derived/non-authoritative)
    if (reason) {
      updated.summary = `[REJECTED: ${reason}] ${page.summary}`.trim();
    }

    await this._savePage(updated);
    await this._updateIndex(updated);
    return { ...updated };
  }

  /**
   * get(pageId)
   * @returns {object|null}
   */
  async get(pageId) {
    if (!pageId) return null;
    const page = await this._loadPage(pageId);
    return page ? { ...page } : null;
  }

  /**
   * getBySlug(slug)
   * Look up a page by its URL-safe slug. Returns the first match.
   * @returns {object|null}
   */
  async getBySlug(slug) {
    if (!slug) return null;
    const index = await this._loadIndex();
    const stub = index.find((s) => s.slug === slug);
    if (!stub) return null;
    const page = await this._loadPage(stub.pageId);
    return page ? { ...page } : null;
  }

  /**
   * search(query)
   * Case-insensitive search across title and content. Returns full page objects.
   * @returns {object[]}
   */
  async search(query) {
    if (!query) return [];
    const needle = query.toLowerCase();
    const index = await this._loadIndex();
    const results = [];
    for (const stub of index) {
      if (stub.title.toLowerCase().includes(needle)) {
        const page = await this._loadPage(stub.pageId);
        if (page) {
          results.push({ ...page });
          continue;
        }
      }
      const page = await this._loadPage(stub.pageId);
      if (page && page.content.toLowerCase().includes(needle)) {
        results.push({ ...page });
      }
    }
    return results;
  }

  /**
   * list({ status, tags, limit })
   * Return filtered pages.
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
      const page = await this._loadPage(stub.pageId);
      if (page) results.push({ ...page });
    }
    return results;
  }

  /**
   * linkPages(pageId, linkedPageId)
   * Adds linkedPageId to page.linkedPages (deduplicated).
   * @returns {object} The updated page.
   */
  async linkPages(pageId, linkedPageId) {
    if (!pageId) throw new Error('Zikipedia.linkPages: pageId is required');
    if (!linkedPageId) throw new Error('Zikipedia.linkPages: linkedPageId is required');

    const page = await this._loadPage(pageId);
    if (!page) throw new Error(`Zikipedia.linkPages: page not found: ${pageId}`);

    const target = await this._loadPage(linkedPageId);
    if (!target) throw new Error(`Zikipedia.linkPages: target page not found: ${linkedPageId}`);

    const now = new Date().toISOString();
    const linkedPages = [...new Set([...page.linkedPages, linkedPageId])];
    const updated = { ...page, linkedPages, updatedAt: now };

    await this._savePage(updated);
    await this._updateIndex(updated);
    return { ...updated };
  }

  /**
   * export()
   * Returns all approved pages as a plain array.
   * NOTE: summaries in exported pages are DERIVED MATERIAL — not authoritative truth.
   * @returns {object[]}
   */
  async export() {
    return this.list({ status: 'approved', limit: Number.MAX_SAFE_INTEGER });
  }
}

module.exports = { Zikipedia };
