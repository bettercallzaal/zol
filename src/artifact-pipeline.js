'use strict';

// artifact-pipeline.js - Layer 9: Artifact Pipeline for ZOL Persistent Agent Upgrade v2
// CommonJS, no external dependencies.
// Manages lifecycle of artifacts: plan → build → verify → package → deliver

const crypto = require('crypto');

// ---------------------------------------------------------------------------
// Secret patterns — walk content recursively and redact before storage
// ---------------------------------------------------------------------------

const SECRET_PATTERNS = [
  /[0-9a-fA-F]{64}/g,      // 64-char hex (private keys)
  /sk-[a-zA-Z0-9_-]+/g,    // OpenAI/OpenRouter API keys
  /ghp_[a-zA-Z0-9_-]+/g,   // GitHub personal access tokens
];

/**
 * Recursively walk a value and replace matching strings with '[REDACTED]'.
 */
function stripSecrets(value) {
  if (value === null || value === undefined) return value;
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
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = stripSecrets(v);
    }
    return out;
  }
  return value;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Compute SHA-256 of canonical JSON and return it prefixed with 'sha256:'
 * so the value is not mistaken for a raw secret by the state-adapter guard
 * (which blocks bare 64-char hex strings). Callers that need the raw hex
 * can strip the prefix; the public schema exposes the prefixed form.
 */
function contentHash(content) {
  const canonical = JSON.stringify(content);
  const hex = crypto.createHash('sha256').update(canonical, 'utf8').digest('hex');
  return `sha256:${hex}`;
}

/**
 * Bump the patch segment of a semver string.
 * '1.0.0' → '1.0.1'
 */
function bumpPatch(version) {
  const parts = String(version || '1.0.0').split('.');
  if (parts.length !== 3) return '1.0.1';
  const patch = parseInt(parts[2], 10);
  return `${parts[0]}.${parts[1]}.${isNaN(patch) ? 1 : patch + 1}`;
}

// Statuses that are considered "built or later" for version-bump purposes
const BUILT_OR_LATER = new Set(['built', 'verifying', 'verified', 'packaged', 'delivered', 'failed']);

// ---------------------------------------------------------------------------
// ArtifactPipeline
// ---------------------------------------------------------------------------

class ArtifactPipeline {
  /**
   * @param {object} stateStore     - state-adapter store (.get / .put async API)
   * @param {object|null} receiptJournal  - ReceiptJournal instance, or null to skip receipts
   * @param {object} [opts]
   * @param {string} [opts.agentId='zolbot']
   * @param {string} [opts.capsuleId='zol-builder-and-artifact-v1']
   */
  constructor(stateStore, receiptJournal, opts = {}) {
    if (!stateStore || typeof stateStore.get !== 'function' || typeof stateStore.put !== 'function') {
      throw new Error('ArtifactPipeline: stateStore must have async get() and put() methods');
    }
    this._store = stateStore;
    this._journal = receiptJournal || null;
    this._agentId = (opts && opts.agentId) || 'zolbot';
    this._capsuleId = (opts && opts.capsuleId) || 'zol-builder-and-artifact-v1';
  }

  // -------------------------------------------------------------------------
  // Private: index management
  // -------------------------------------------------------------------------

  /**
   * Load the artifact index from state. Returns { artifactIds: string[] }.
   */
  async _loadIndex() {
    const stored = await this._store.get('artifact-index');
    if (stored && Array.isArray(stored.artifactIds)) {
      return stored;
    }
    return { artifactIds: [] };
  }

  /**
   * Persist the artifact index.
   */
  async _saveIndex(index) {
    await this._store.put('artifact-index', index);
  }

  /**
   * Load a single artifact by id. Returns artifact or null.
   */
  async _loadArtifact(artifactId) {
    const stored = await this._store.get(`artifact:${artifactId}`);
    return stored !== undefined && stored !== null ? stored : null;
  }

  /**
   * Persist a single artifact and, if it is new, add its id to the index.
   */
  async _saveArtifact(artifact, { isNew = false } = {}) {
    artifact.updatedAt = new Date().toISOString();
    await this._store.put(`artifact:${artifact.artifactId}`, artifact);

    if (isNew) {
      const index = await this._loadIndex();
      if (!index.artifactIds.includes(artifact.artifactId)) {
        index.artifactIds.push(artifact.artifactId);
        await this._saveIndex(index);
      }
    }
  }

  /**
   * Append a receipt via the journal if one is wired up.
   * Never throws — receipt failures are non-critical.
   */
  async _appendReceipt({ loopId, runId, action, status, evidence }) {
    if (!this._journal) return null;
    try {
      const receipt = await this._journal.append({
        loopId: loopId || this._capsuleId,
        runId: runId || crypto.randomUUID(),
        capsuleId: this._capsuleId,
        action,
        status,
        evidence: evidence || null,
      });
      return receipt ? receipt.receiptId : null;
    } catch (err) {
      // Best-effort
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Plan a new artifact. Returns the created artifact with status='planned'.
   *
   * @param {object} opts
   * @param {string}   opts.type
   * @param {string}   opts.title
   * @param {string}   opts.description
   * @param {string}   [opts.workPacketId=null]
   * @param {string[]} [opts.sourceReferences=[]]
   * @param {string[]} [opts.tags=[]]
   * @param {string}   [opts.permissions='private']
   * @param {object}   [opts.metadata={}]
   * @returns {Promise<object>} artifact
   */
  async plan({
    type,
    title,
    description,
    workPacketId = null,
    sourceReferences = [],
    tags = [],
    permissions = 'private',
    metadata = {},
  }) {
    if (!type) throw new Error('ArtifactPipeline.plan: type is required');
    if (!title) throw new Error('ArtifactPipeline.plan: title is required');
    if (!description) throw new Error('ArtifactPipeline.plan: description is required');

    const now = new Date().toISOString();
    const artifactId = `art_${crypto.randomUUID()}`;

    const artifact = {
      artifactId,
      type,
      title,
      description,
      status: 'planned',
      version: '1.0.0',
      content: null,
      contentHash: null,
      format: 'json',
      sourceReferences: Array.isArray(sourceReferences) ? [...sourceReferences] : [],
      workPacketId: workPacketId || null,
      capsuleId: this._capsuleId,
      agentId: this._agentId,
      permissions,
      createdAt: now,
      updatedAt: now,
      deliveredAt: null,
      verificationEvidence: null,
      receiptIds: [],
      tags: Array.isArray(tags) ? [...tags] : [],
      metadata: metadata && typeof metadata === 'object' ? { ...metadata } : {},
    };

    await this._saveArtifact(artifact, { isNew: true });

    // Receipt: artifact.plan
    const receiptId = await this._appendReceipt({
      action: 'artifact.plan',
      status: 'success',
      evidence: { artifactId, type, title },
    });
    if (receiptId) {
      artifact.receiptIds.push(receiptId);
      await this._saveArtifact(artifact);
    }

    return artifact;
  }

  /**
   * Build an artifact: attach secret-stripped content and compute its hash.
   * Bumps patch version if the artifact was already built or further along.
   *
   * @param {string} artifactId
   * @param {any}    content     - artifact payload (will have secrets stripped)
   * @param {object} [opts]
   * @param {string} [opts.format='json']
   * @returns {Promise<object>} updated artifact
   */
  async build(artifactId, content, { format = 'json' } = {}) {
    const artifact = await this._loadArtifact(artifactId);
    if (!artifact) throw new Error(`ArtifactPipeline.build: artifact not found: ${artifactId}`);

    // Bump patch version if already built or beyond
    if (BUILT_OR_LATER.has(artifact.status)) {
      artifact.version = bumpPatch(artifact.version);
    }

    const cleaned = stripSecrets(content);
    artifact.content = cleaned;
    artifact.contentHash = contentHash(cleaned);
    artifact.format = format || 'json';
    artifact.status = 'built';

    await this._saveArtifact(artifact);
    return artifact;
  }

  /**
   * Verify an artifact with external evidence.
   * Sets status to 'verified' if evidence.passed === true, else 'failed'.
   *
   * @param {string} artifactId
   * @param {object} evidence    - { passed: boolean, ...other fields }
   * @returns {Promise<object>} updated artifact
   */
  async verify(artifactId, evidence) {
    const artifact = await this._loadArtifact(artifactId);
    if (!artifact) throw new Error(`ArtifactPipeline.verify: artifact not found: ${artifactId}`);

    artifact.verificationEvidence = evidence && typeof evidence === 'object' ? { ...evidence } : evidence;
    artifact.status = (evidence && evidence.passed === true) ? 'verified' : 'failed';

    await this._saveArtifact(artifact);
    return artifact;
  }

  /**
   * Package a verified artifact for delivery. Bumps patch version if
   * re-packaging an already-packaged artifact.
   *
   * @param {string} artifactId
   * @returns {Promise<object>} updated artifact
   */
  async package(artifactId) {
    const artifact = await this._loadArtifact(artifactId);
    if (!artifact) throw new Error(`ArtifactPipeline.package: artifact not found: ${artifactId}`);

    // Bump version on re-packaging
    if (artifact.status === 'packaged') {
      artifact.version = bumpPatch(artifact.version);
    }

    artifact.status = 'packaged';

    await this._saveArtifact(artifact);
    return artifact;
  }

  /**
   * Deliver a packaged artifact. Sets deliveredAt, appends receiptId to receiptIds.
   *
   * @param {string} artifactId
   * @param {object} [opts]
   * @param {string} [opts.receiptId]  - external receiptId to attach
   * @returns {Promise<object>} updated artifact
   */
  async deliver(artifactId, { receiptId } = {}) {
    const artifact = await this._loadArtifact(artifactId);
    if (!artifact) throw new Error(`ArtifactPipeline.deliver: artifact not found: ${artifactId}`);

    artifact.status = 'delivered';
    artifact.deliveredAt = new Date().toISOString();

    if (receiptId) {
      artifact.receiptIds.push(receiptId);
    }

    await this._saveArtifact(artifact);

    // Receipt: artifact.deliver
    const journalReceiptId = await this._appendReceipt({
      action: 'artifact.deliver',
      status: 'success',
      evidence: { artifactId, deliveredAt: artifact.deliveredAt },
    });
    if (journalReceiptId) {
      artifact.receiptIds.push(journalReceiptId);
      await this._saveArtifact(artifact);
    }

    return artifact;
  }

  /**
   * Retrieve an artifact by id.
   *
   * @param {string} artifactId
   * @returns {Promise<object|null>}
   */
  async get(artifactId) {
    return this._loadArtifact(artifactId);
  }

  /**
   * List artifacts, newest-first, with optional filtering.
   * Returns a lightweight summary projection for each artifact.
   *
   * @param {object} [opts]
   * @param {string} [opts.type]          - filter by type
   * @param {string} [opts.status]        - filter by status
   * @param {string} [opts.workPacketId]  - filter by workPacketId
   * @param {number} [opts.limit=50]      - max results
   * @returns {Promise<object[]>} array of summary objects
   */
  async list({ type, status, workPacketId, limit = 50 } = {}) {
    const index = await this._loadIndex();
    // Newest-first: reverse the order of IDs (they were pushed in creation order)
    const ids = [...index.artifactIds].reverse();

    const results = [];
    for (const id of ids) {
      if (results.length >= limit) break;

      const artifact = await this._loadArtifact(id);
      if (!artifact) continue;

      if (type && artifact.type !== type) continue;
      if (status && artifact.status !== status) continue;
      if (workPacketId && artifact.workPacketId !== workPacketId) continue;

      results.push({
        artifactId: artifact.artifactId,
        type: artifact.type,
        title: artifact.title,
        status: artifact.status,
        version: artifact.version,
        contentHash: artifact.contentHash,
        permissions: artifact.permissions,
        createdAt: artifact.createdAt,
      });
    }

    return results;
  }

  /**
   * Export an artifact. Redacts content fields if permissions==='private'
   * and redactPrivate is true. Used by Proof Drop.
   *
   * @param {string} artifactId
   * @param {object} [opts]
   * @param {boolean} [opts.redactPrivate=true]
   * @returns {Promise<object|null>}
   */
  async export(artifactId, { redactPrivate = true } = {}) {
    const artifact = await this._loadArtifact(artifactId);
    if (!artifact) return null;

    // Deep clone
    const exported = JSON.parse(JSON.stringify(artifact));

    if (redactPrivate && exported.permissions === 'private') {
      exported.content = '[REDACTED]';
      exported.verificationEvidence = exported.verificationEvidence !== null ? '[REDACTED]' : null;
    }

    return exported;
  }

  /**
   * Create a trapper bundle artifact that wraps the target artifact and its
   * receipts, sanitized for export.
   *
   * @param {string}   artifactId
   * @param {string[]} [receiptIds=[]]   - additional receipt IDs to include
   * @returns {Promise<object>} the new bundle artifact
   */
  async createTrapperBundle(artifactId, receiptIds = []) {
    const artifact = await this._loadArtifact(artifactId);
    if (!artifact) throw new Error(`ArtifactPipeline.createTrapperBundle: artifact not found: ${artifactId}`);

    // Build sanitized copy of the target artifact (strip secrets from content)
    const sanitizedArtifact = JSON.parse(JSON.stringify(artifact));
    if (sanitizedArtifact.content !== null && sanitizedArtifact.content !== undefined) {
      sanitizedArtifact.content = stripSecrets(sanitizedArtifact.content);
    }

    // Merge receiptIds from the target artifact and the caller-supplied list
    const allReceiptIds = Array.from(new Set([...artifact.receiptIds, ...receiptIds]));

    const bundleContent = {
      bundleType: 'trapper',
      targetArtifactId: artifactId,
      targetArtifact: sanitizedArtifact,
      receiptIds: allReceiptIds,
      bundledAt: new Date().toISOString(),
    };

    // Plan the bundle artifact
    const bundle = await this.plan({
      type: 'trapper',
      title: `Trapper bundle for ${artifact.title}`,
      description: `Sanitized export bundle containing artifact ${artifactId} and ${allReceiptIds.length} receipt(s).`,
      workPacketId: artifact.workPacketId,
      sourceReferences: [artifactId],
      tags: ['trapper-bundle', ...artifact.tags],
      permissions: 'shared',
      metadata: { targetArtifactId: artifactId, receiptCount: allReceiptIds.length },
    });

    // Build and package it immediately
    await this.build(bundle.artifactId, bundleContent, { format: 'json' });
    await this.package(bundle.artifactId);

    // Return the latest persisted state
    return this._loadArtifact(bundle.artifactId);
  }
}

module.exports = { ArtifactPipeline };
