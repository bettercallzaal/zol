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

const SECRET_PATTERNS = [
  /[0-9a-fA-F]{64}/g,       // 64-char hex (eth private key / raw SHA-256)
  /sk-[a-zA-Z0-9_-]+/g,     // OpenAI / Anthropic / OpenRouter API keys
  /ghp_[a-zA-Z0-9_-]+/g,    // GitHub personal access tokens
];

// Evidence field keys that must never appear in a proof-drop bundle
const PRIVATE_EVIDENCE_KEYS = new Set(['prompt', 'privateKey', 'memory']);

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
 * Remove private evidence keys from a receipt's evidence object.
 * Returns { cleaned, redactedPaths } where redactedPaths lists every
 * dot-path that was removed (e.g. 'evidence.prompt').
 *
 * @param {object|null} evidence
 * @param {string}      basePath  prefix for path reporting
 * @returns {{ cleaned: object|null, redactedPaths: string[] }}
 */
function sanitizeEvidenceFields(evidence, basePath = 'evidence') {
  if (!evidence || typeof evidence !== 'object') {
    return { cleaned: evidence, redactedPaths: [] };
  }

  const cleaned = {};
  const redactedPaths = [];

  for (const [key, value] of Object.entries(evidence)) {
    const path = `${basePath}.${key}`;
    if (PRIVATE_EVIDENCE_KEYS.has(key)) {
      redactedPaths.push(path);
      // Do not copy this key into cleaned
    } else {
      cleaned[key] = value;
    }
  }

  return { cleaned, redactedPaths };
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

    // 4. Sanitize each receipt and collect redacted paths
    const allRedactedPaths = [];
    const sanitizedReceipts = relatedReceipts.map(receipt => {
      const { cleaned: cleanedEvidence, redactedPaths } = sanitizeEvidenceFields(
        receipt.evidence,
        `receipts[${receipt.receiptId}].evidence`
      );
      allRedactedPaths.push(...redactedPaths);

      // Build a receipt copy that excludes the evidence.prompt / private keys
      // and redacts secrets in remaining string values
      const sanitized = {
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
        evidence: redactSecrets(cleanedEvidence),
      };

      return sanitized;
    });

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
