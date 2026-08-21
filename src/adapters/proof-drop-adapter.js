'use strict';

// src/adapters/proof-drop-adapter.js
// Layer 14: Export sanitized proof-drop bundles from completed Trappers.
// Exposes only public verification evidence — never prompts, private memory,
// credentials, or internal files.
// CommonJS, no external dependencies.

const crypto = require('crypto');

// ---------------------------------------------------------------------------
// Secret patterns — redact these from any string value in the bundle
// ---------------------------------------------------------------------------

// Credential patterns — redact these from any string value in the bundle.
// SHA-256 hashes (contentHash, receipt sha256) are evidence and must NOT be redacted.
const SECRET_PATTERNS = [
  /sk-[a-zA-Z0-9_-]{20,}/g,   // OpenAI / Anthropic / OpenRouter API keys
  /ghp_[a-zA-Z0-9_-]{4,}/g,   // GitHub personal access tokens
  /github_pat_[a-zA-Z0-9_]+/g, // GitHub PATs v2
  /ghs_[a-zA-Z0-9_]+/g,        // GitHub Actions tokens
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

// Evidence field keys that must never appear in a proof-drop bundle.
// These are removed recursively from nested evidence objects.
const PRIVATE_EVIDENCE_KEYS = new Set([
  'prompt', 'privateKey', 'memory', 'secret', 'token', 'credential', 'credentials',
  'apiKey', 'api_key', 'password', 'mnemonic', 'seed',
]);

// Valid contentHash format: "sha256:<64 hex chars>"
const CONTENT_HASH_RE = /^sha256:[0-9a-f]{64}$/;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Recursively walk any value and replace secret-matching strings with
 * '[REDACTED]'. Returns the sanitized value; the original is not mutated.
 *
 * @param {*} value
 * @returns {*} sanitized clone
 */
function redactSecrets(value) {
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
    return value.map(redactSecrets);
  }
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = redactSecrets(v);
    }
    return out;
  }
  return value;
}

/**
 * Recursively remove private evidence keys from an evidence object.
 * Returns { cleaned, redactedPaths } where redactedPaths lists every
 * dot-path that was removed (e.g. 'evidence.prompt', 'evidence.nested.token').
 *
 * @param {*}      evidence
 * @param {string} basePath  prefix for path reporting
 * @returns {{ cleaned: *, redactedPaths: string[] }}
 */
function sanitizeEvidenceFields(evidence, basePath = 'evidence') {
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) {
    return { cleaned: evidence, redactedPaths: [] };
  }

  const cleaned = {};
  const redactedPaths = [];

  for (const [key, value] of Object.entries(evidence)) {
    const path = `${basePath}.${key}`;
    if (PRIVATE_EVIDENCE_KEYS.has(key)) {
      redactedPaths.push(path);
    } else if (value && typeof value === 'object' && !Array.isArray(value)) {
      // Recurse into nested objects
      const { cleaned: nestedCleaned, redactedPaths: nestedPaths } = sanitizeEvidenceFields(value, path);
      cleaned[key] = nestedCleaned;
      redactedPaths.push(...nestedPaths);
    } else {
      cleaned[key] = value;
    }
  }

  return { cleaned, redactedPaths };
}

/**
 * Validate that a receipt has the minimum required structural fields.
 * Returns an error string if invalid, or null if valid.
 */
function validateReceiptStructure(receipt, index) {
  const required = ['receiptId', 'action', 'status', 'agentId'];
  for (const field of required) {
    if (!receipt[field]) {
      return `receipt[${index}] missing required field: ${field}`;
    }
  }
  const validStatuses = ['success', 'failure', 'pending'];
  if (!validStatuses.includes(receipt.status)) {
    return `receipt[${index}].status is invalid: "${receipt.status}"`;
  }
  return null;
}

/**
 * Determine whether a receipt belongs to the target artifact.
 * A receipt matches if its evidence contains the artifactId, or if the
 * artifactId is in the artifact's own receiptIds list.
 *
 * @param {object}   receipt
 * @param {string}   artifactId
 * @param {Set<string>} receiptIdSet  set of receipt IDs in artifact.receiptIds
 * @returns {boolean}
 */
function receiptBelongsToArtifact(receipt, artifactId, receiptIdSet) {
  // Check: receipt is listed in artifact.receiptIds
  if (receiptIdSet.has(receipt.receiptId)) return true;

  // Check: receipt evidence mentions the artifactId
  if (receipt.evidence && typeof receipt.evidence === 'object') {
    const evidenceStr = JSON.stringify(receipt.evidence);
    if (evidenceStr.includes(artifactId)) return true;
  }

  return false;
}

/**
 * Collect unique loopIds from a list of receipts.
 *
 * @param {object[]} receipts
 * @returns {string[]}
 */
function collectLoopIds(receipts) {
  const seen = new Set();
  for (const r of receipts) {
    if (r.loopId) seen.add(r.loopId);
  }
  return Array.from(seen);
}

// ---------------------------------------------------------------------------
// ProofDropAdapter
// ---------------------------------------------------------------------------

class ProofDropAdapter {
  /**
   * @param {object} artifactPipeline  - ArtifactPipeline instance
   * @param {object} receiptJournal    - ReceiptJournal instance
   * @param {object} [opts]
   * @param {string} [opts.agentId='zolbot']
   */
  constructor(artifactPipeline, receiptJournal, { agentId = 'zolbot' } = {}) {
    if (!artifactPipeline || typeof artifactPipeline.get !== 'function') {
      throw new Error('ProofDropAdapter: artifactPipeline must have a get() method');
    }
    if (!receiptJournal || typeof receiptJournal.list !== 'function') {
      throw new Error('ProofDropAdapter: receiptJournal must have a list() method');
    }
    this._pipeline = artifactPipeline;
    this._journal = receiptJournal;
    this._agentId = agentId;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Export a sanitized proof-drop bundle for a delivered artifact.
   *
   * Only public verification evidence is included. Private evidence keys
   * (prompt, privateKey, memory) are stripped; secret patterns in any string
   * value are redacted.
   *
   * @param {string} artifactId
   * @returns {Promise<object>} proof-drop bundle
   * @throws {Error} 'artifact not found' if the artifact does not exist
   * @throws {Error} 'artifact not delivered' if status !== 'delivered'
   */
  async export(artifactId) {
    // 1. Load artifact
    const artifact = await this._pipeline.get(artifactId);
    if (!artifact) {
      throw new Error('artifact not found');
    }
    if (artifact.status !== 'delivered') {
      throw new Error('artifact not delivered');
    }

    // 2. Fetch recent receipts
    const allReceipts = await this._journal.list({ limit: 100 });

    // Build a fast lookup set for the artifact's own receipt IDs
    const artifactReceiptIdSet = new Set(
      Array.isArray(artifact.receiptIds) ? artifact.receiptIds : []
    );

    // 3. Filter receipts that belong to this artifact
    const relatedReceipts = allReceipts.filter(r =>
      receiptBelongsToArtifact(r, artifactId, artifactReceiptIdSet)
    );

    // 4. Validate receipt structure, sanitize, and collect redacted paths
    const allRedactedPaths = [];
    const sanitizedReceipts = [];
    for (let i = 0; i < relatedReceipts.length; i++) {
      const receipt = relatedReceipts[i];
      const structErr = validateReceiptStructure(receipt, i);
      if (structErr) {
        // Skip malformed receipts and note the exclusion
        allRedactedPaths.push(`[excluded:${structErr}]`);
        continue;
      }

      const { cleaned: cleanedEvidence, redactedPaths } = sanitizeEvidenceFields(
        receipt.evidence,
        `receipts[${receipt.receiptId}].evidence`
      );
      allRedactedPaths.push(...redactedPaths);

      sanitizedReceipts.push({
        receiptId: receipt.receiptId,
        loopId: receipt.loopId,
        runId: receipt.runId,
        stepId: receipt.stepId,
        capsuleId: receipt.capsuleId,
        agentId: receipt.agentId,
        action: receipt.action,
        status: receipt.status,
        startedAt: receipt.startedAt,
        finishedAt: receipt.finishedAt,
        durationMs: receipt.durationMs,
        sha256: receipt.sha256 || null,
        previousReceiptId: receipt.previousReceiptId || null,
        previousReceiptHash: receipt.previousReceiptHash || null,
        evidence: redactSecrets(cleanedEvidence),
      });
    }

    // 5. Extract only public evidence from the artifact's verificationEvidence
    let publicEvidence = {};
    if (artifact.verificationEvidence && typeof artifact.verificationEvidence === 'object') {
      // Prefer an explicit 'public' or 'verification' sub-key; fall back to {}
      if (artifact.verificationEvidence.public &&
          typeof artifact.verificationEvidence.public === 'object') {
        publicEvidence = redactSecrets({ ...artifact.verificationEvidence.public });
      } else if (artifact.verificationEvidence.verification &&
                 typeof artifact.verificationEvidence.verification === 'object') {
        publicEvidence = redactSecrets({ ...artifact.verificationEvidence.verification });
      }
      // Otherwise leave publicEvidence as {}
    }

    // 6. Build attestation
    const loopIds = collectLoopIds(relatedReceipts);
    const attestation = {
      stepsCompleted: sanitizedReceipts.length,
      loopIds,
      deliveredAt: artifact.deliveredAt || null,
    };

    // 7. Assemble the bundle
    const bundle = {
      bundleId: `pd_${crypto.randomUUID()}`,
      version: '1.0.0',
      generatedAt: new Date().toISOString(),
      generatedBy: this._agentId,
      artifactId: artifact.artifactId,
      artifactTitle: artifact.title,
      artifactType: artifact.type,
      contentHash: artifact.contentHash,
      receipts: sanitizedReceipts,
      publicEvidence,
      attestation,
      redacted: allRedactedPaths,
    };

    // 8. Final sweep: redact any secret patterns that slipped through
    return redactSecrets(bundle);
  }

  /**
   * Validate a proof-drop bundle for structural completeness and the absence
   * of secret patterns.
   *
   * @param {object} bundle
   * @returns {{ valid: boolean, errors: string[] }}
   */
  validate(bundle) {
    const errors = [];

    if (!bundle || typeof bundle !== 'object') {
      return { valid: false, errors: ['bundle must be an object'] };
    }

    // Required fields
    const required = ['bundleId', 'artifactId', 'contentHash', 'receipts', 'generatedAt'];
    for (const field of required) {
      if (bundle[field] === undefined || bundle[field] === null) {
        errors.push(`missing required field: ${field}`);
      }
    }

    // contentHash must be a valid "sha256:<64 hex chars>" string
    if (bundle.contentHash !== undefined && bundle.contentHash !== null) {
      if (!CONTENT_HASH_RE.test(bundle.contentHash)) {
        errors.push(
          `contentHash is not a valid proof: "${bundle.contentHash}". ` +
          'Expected format: sha256:<64 lowercase hex chars>. ' +
          'sha256:[REDACTED] is rejected — contentHash is evidence, not a secret.'
        );
      }
    }

    // receipts must be an array
    if (bundle.receipts !== undefined && !Array.isArray(bundle.receipts)) {
      errors.push('receipts must be an array');
    }

    // Scan all string values for secret patterns
    const bundleStr = JSON.stringify(bundle);
    for (const pattern of SECRET_PATTERNS) {
      pattern.lastIndex = 0;
      if (pattern.test(bundleStr)) {
        errors.push(`bundle contains secret pattern matching: ${pattern.toString()}`);
      }
    }

    return { valid: errors.length === 0, errors };
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = { ProofDropAdapter };
