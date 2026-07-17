'use strict';

// capsule-registry.js - CapsuleRegistry for ZOL Persistent Agent Upgrade v2
// Manages DreamNet synergy capsule lifecycle: install, validate, activate, disable, rollback, list.
//
// State key: "capsule-registry"
// Schema version: "dreamnet.synergy_capsule.v1"

const crypto = require('crypto');

const REGISTRY_KEY = 'capsule-registry';
const REQUIRED_SCHEMA = 'dreamnet.synergy_capsule.v1';

/**
 * Canonically sort all keys in a plain object (nested), then JSON.stringify.
 * Used to produce a stable hash regardless of insertion order.
 */
function canonicalJson(value) {
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalJson).join(',') + ']';
  }
  if (value !== null && typeof value === 'object') {
    const sorted = Object.keys(value)
      .sort()
      .map((k) => JSON.stringify(k) + ':' + canonicalJson(value[k]));
    return '{' + sorted.join(',') + '}';
  }
  return JSON.stringify(value);
}

/**
 * Compute a SHA-256 hash over the capsule payload + permissions using canonical JSON.
 * Only the fields that define capsule identity (payload + permissions) are hashed.
 */
function computeCapsuleHash(capsuleJson) {
  const subject = {
    capsule_id: capsuleJson.capsule_id,
    name: capsuleJson.name,
    version: capsuleJson.version,
    permissions: capsuleJson.permissions,
  };
  // Include payload if present
  if (capsuleJson.payload !== undefined) {
    subject.payload = capsuleJson.payload;
  }
  const canonical = canonicalJson(subject);
  return crypto.createHash('sha256').update(canonical, 'utf8').digest('hex');
}

class CapsuleRegistry {
  /**
   * @param {object} stateStore - A state-adapter store instance (get/put/initialize).
   */
  constructor(stateStore) {
    if (!stateStore) throw new Error('CapsuleRegistry requires a stateStore');
    this.stateStore = stateStore;
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  /** Load registry state, returning a default structure if not yet persisted. */
  async _load() {
    const data = await this.stateStore.get(REGISTRY_KEY);
    if (!data) return { capsules: {} };
    return data;
  }

  /** Persist registry state. */
  async _save(registry) {
    await this.stateStore.put(REGISTRY_KEY, registry);
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * validate(capsuleJson) - Check required fields without side effects.
   * @returns {{ valid: boolean, errors: string[] }}
   */
  validate(capsuleJson) {
    const errors = [];

    if (!capsuleJson || typeof capsuleJson !== 'object') {
      return { valid: false, errors: ['capsuleJson must be a non-null object'] };
    }

    if (capsuleJson.schema !== REQUIRED_SCHEMA) {
      errors.push(`schema must be "${REQUIRED_SCHEMA}", got: ${JSON.stringify(capsuleJson.schema)}`);
    }

    if (!capsuleJson.capsule_id || typeof capsuleJson.capsule_id !== 'string') {
      errors.push('capsule_id is required and must be a string');
    }

    if (!capsuleJson.name || typeof capsuleJson.name !== 'string') {
      errors.push('name is required and must be a string');
    }

    if (!capsuleJson.version || typeof capsuleJson.version !== 'string') {
      errors.push('version is required and must be a string');
    }

    const perms = capsuleJson.permissions;
    if (!perms || typeof perms !== 'object' || Array.isArray(perms)) {
      errors.push('permissions is required and must be an object');
    } else {
      if (!Array.isArray(perms.allowed)) {
        errors.push('permissions.allowed is required and must be an array');
      }
      if (!Array.isArray(perms.blocked)) {
        errors.push('permissions.blocked is required and must be an array');
      }
    }

    return { valid: errors.length === 0, errors };
  }

  /**
   * install(capsuleJson) - Validate and install a capsule into the registry.
   * Idempotent: installing the same version twice returns the existing record.
   * @returns {{ capsuleId: string, version: string, hash: string, status: string }}
   */
  async install(capsuleJson) {
    const { valid, errors } = this.validate(capsuleJson);
    if (!valid) {
      throw new Error(`[CapsuleRegistry] Invalid capsule: ${errors.join('; ')}`);
    }

    const capsuleId = capsuleJson.capsule_id;
    const version = capsuleJson.version;
    const hash = computeCapsuleHash(capsuleJson);

    const registry = await this._load();
    if (!registry.capsules[capsuleId]) {
      registry.capsules[capsuleId] = { current: null, history: [] };
    }

    const entry = registry.capsules[capsuleId];

    // Idempotent: same version + same hash => no-op
    if (entry.current && entry.current.version === version && entry.current.hash === hash) {
      return {
        capsuleId,
        version: entry.current.version,
        hash: entry.current.hash,
        status: entry.current.status,
      };
    }

    // Archive existing current to history before replacing
    if (entry.current) {
      entry.history.push({ ...entry.current });
    }

    const now = new Date().toISOString();
    entry.current = {
      ...capsuleJson,
      status: 'installed',
      hash,
      installedAt: now,
    };

    await this._save(registry);

    return { capsuleId, version, hash, status: 'installed' };
  }

  /**
   * activate(capsuleId) - Set capsule status to "active".
   * @returns {{ capsuleId: string, status: "active", activatedAt: string }}
   */
  async activate(capsuleId) {
    const registry = await this._load();
    const entry = registry.capsules[capsuleId];

    if (!entry || !entry.current) {
      throw new Error(`[CapsuleRegistry] Capsule not found: ${capsuleId}`);
    }

    const activatedAt = new Date().toISOString();
    entry.current.status = 'active';
    entry.current.activatedAt = activatedAt;

    await this._save(registry);

    return { capsuleId, status: 'active', activatedAt };
  }

  /**
   * disable(capsuleId) - Set capsule status to "disabled".
   * @returns {{ capsuleId: string, status: "disabled" }}
   */
  async disable(capsuleId) {
    const registry = await this._load();
    const entry = registry.capsules[capsuleId];

    if (!entry || !entry.current) {
      throw new Error(`[CapsuleRegistry] Capsule not found: ${capsuleId}`);
    }

    entry.current.status = 'disabled';

    await this._save(registry);

    return { capsuleId, status: 'disabled' };
  }

  /**
   * rollback(capsuleId, toVersion) - Restore a previously installed version from history.
   * @returns {{ capsuleId: string, rolledBackTo: string }}
   */
  async rollback(capsuleId, toVersion) {
    const registry = await this._load();
    const entry = registry.capsules[capsuleId];

    if (!entry) {
      throw new Error(`[CapsuleRegistry] Capsule not found: ${capsuleId}`);
    }

    const historyIndex = entry.history.findIndex((h) => h.version === toVersion);
    if (historyIndex === -1) {
      throw new Error(
        `[CapsuleRegistry] No history entry for capsule "${capsuleId}" at version "${toVersion}"`
      );
    }

    const targetSnapshot = entry.history[historyIndex];

    // Archive current to history before restoring
    if (entry.current) {
      entry.history.push({ ...entry.current });
    }

    // Remove the restored snapshot from history (it becomes current)
    entry.history.splice(historyIndex, 1);

    entry.current = {
      ...targetSnapshot,
      status: 'rolled-back',
      installedAt: entry.current ? entry.current.installedAt : targetSnapshot.installedAt,
      rolledBackAt: new Date().toISOString(),
    };

    await this._save(registry);

    return { capsuleId, rolledBackTo: toVersion };
  }

  /**
   * list() - Return summary records for all installed capsules.
   * @returns {Array<{ capsuleId: string, version: string, status: string, hash: string, installedAt: string }>}
   */
  async list() {
    const registry = await this._load();
    return Object.entries(registry.capsules)
      .filter(([, entry]) => entry.current)
      .map(([capsuleId, entry]) => ({
        capsuleId,
        version: entry.current.version,
        status: entry.current.status,
        hash: entry.current.hash,
        installedAt: entry.current.installedAt,
      }));
  }

  /**
   * get(capsuleId) - Return the full current capsule record, or null if not found.
   * @returns {object|null}
   */
  async get(capsuleId) {
    const registry = await this._load();
    const entry = registry.capsules[capsuleId];
    if (!entry || !entry.current) return null;
    return { ...entry.current };
  }
}

module.exports = { CapsuleRegistry };
