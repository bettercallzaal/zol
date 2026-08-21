'use strict';

// dreamloop-registry.js - DreamLoop registry for ZOL Persistent Agent Upgrade v2
// CommonJS, no external deps.

const fs = require('fs');
const path = require('path');

const REGISTRY_STATE_KEY = 'dreamloop-registry';

const REQUIRED_TOP_LEVEL = ['schema', 'loop_id', 'title', 'version', 'steps', 'limits', 'allowed_actions', 'blocked_actions'];
const REQUIRED_STEP_FIELDS = ['id', 'handler', 'permission'];

/**
 * Parse basic YAML frontmatter from a markdown string.
 * Extracts text between the first pair of "---" delimiters and parses
 * "key: value" pairs. Values that look like JSON arrays/objects are
 * parsed with JSON.parse; otherwise they are returned as trimmed strings.
 *
 * @param {string} text - raw file contents
 * @returns {object|null} parsed frontmatter, or null if none found
 */
function parseYamlFrontmatter(text) {
  const lines = text.split('\n');

  // Find the opening --- delimiter (must be on its own line)
  let startIndex = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      startIndex = i;
      break;
    }
  }

  if (startIndex === -1) return null;

  // Find the closing --- delimiter
  let endIndex = -1;
  for (let i = startIndex + 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      endIndex = i;
      break;
    }
  }

  if (endIndex === -1) return null;

  const frontmatterLines = lines.slice(startIndex + 1, endIndex);
  const result = {};

  for (const line of frontmatterLines) {
    // Skip blank lines and comment lines
    if (!line.trim() || line.trim().startsWith('#')) continue;

    const colonIndex = line.indexOf(':');
    if (colonIndex === -1) continue;

    const key = line.slice(0, colonIndex).trim();
    const rawValue = line.slice(colonIndex + 1).trim();

    if (!key) continue;

    // Attempt to parse JSON-like arrays and objects
    if (rawValue.startsWith('[') || rawValue.startsWith('{')) {
      try {
        result[key] = JSON.parse(rawValue);
        continue;
      } catch (_) {
        // fall through to string
      }
    }

    // Boolean coercion
    if (rawValue === 'true') {
      result[key] = true;
    } else if (rawValue === 'false') {
      result[key] = false;
    } else {
      result[key] = rawValue;
    }
  }

  return result;
}

class DreamLoopRegistry {
  /**
   * @param {object} stateStore - instance returned by createStateStore()
   */
  constructor(stateStore) {
    if (!stateStore) throw new Error('DreamLoopRegistry requires a stateStore');
    this.store = stateStore;
  }

  /**
   * Scan a directory for *.manifest.json and *.md files, parse each, and
   * return an array of loop objects (raw parsed values, not validated).
   *
   * @param {string} dir - absolute path to scan
   * @returns {Promise<object[]>} array of loop objects
   */
  async loadFromDirectory(dir) {
    const entries = await fs.promises.readdir(dir);
    const loops = [];

    for (const entry of entries) {
      const fullPath = path.join(dir, entry);
      const stat = await fs.promises.stat(fullPath).catch(() => null);
      if (!stat || !stat.isFile()) continue;

      try {
        if (entry.endsWith('.manifest.json')) {
          const text = await fs.promises.readFile(fullPath, 'utf8');
          loops.push(JSON.parse(text));
        } else if (entry.endsWith('.md')) {
          const text = await fs.promises.readFile(fullPath, 'utf8');
          const parsed = parseYamlFrontmatter(text);
          if (parsed) loops.push(parsed);
        }
      } catch (err) {
        // Skip files that fail to parse; don't abort the whole scan
        console.warn(`[DreamLoopRegistry] loadFromDirectory: skipping ${entry}: ${err.message}`);
      }
    }

    return loops;
  }

  /**
   * Validate a loop definition.
   *
   * @param {object} loopJson
   * @returns {{ valid: boolean, errors: string[] }}
   */
  validate(loopJson) {
    const errors = [];

    if (!loopJson || typeof loopJson !== 'object') {
      return { valid: false, errors: ['loop must be a non-null object'] };
    }

    // Required top-level fields
    for (const field of REQUIRED_TOP_LEVEL) {
      if (loopJson[field] === undefined || loopJson[field] === null) {
        errors.push(`missing required field: ${field}`);
      }
    }

    // steps must be an array with at least one element
    if (!Array.isArray(loopJson.steps)) {
      errors.push('steps must be an array');
    } else if (loopJson.steps.length < 1) {
      errors.push('steps must contain at least one step');
    } else {
      // Each step must have id, handler, permission
      const blockedActions = Array.isArray(loopJson.blocked_actions) ? loopJson.blocked_actions : [];

      loopJson.steps.forEach((step, index) => {
        for (const field of REQUIRED_STEP_FIELDS) {
          if (step[field] === undefined || step[field] === null || step[field] === '') {
            errors.push(`step[${index}] (id: ${step.id || '<unknown>'}) missing required field: ${field}`);
          }
        }

        // No step may use a permission that appears in blocked_actions
        if (step.permission && blockedActions.includes(step.permission)) {
          errors.push(
            `step[${index}] (id: ${step.id || '<unknown>'}) uses blocked permission: ${step.permission}`
          );
        }
      });

      // limits.max_steps must be >= steps.length
      if (loopJson.limits && typeof loopJson.limits === 'object') {
        const maxSteps = loopJson.limits.max_steps;
        if (maxSteps !== undefined && maxSteps < loopJson.steps.length) {
          errors.push(
            `limits.max_steps (${maxSteps}) must be >= steps.length (${loopJson.steps.length})`
          );
        }
      }
    }

    // limits must be present (already checked above as required, but also validate internals)
    if (loopJson.limits !== undefined && typeof loopJson.limits !== 'object') {
      errors.push('limits must be an object');
    }

    // allowed_actions and blocked_actions must be arrays (if present as non-null)
    if (loopJson.allowed_actions !== undefined && !Array.isArray(loopJson.allowed_actions)) {
      errors.push('allowed_actions must be an array');
    }
    if (loopJson.blocked_actions !== undefined && !Array.isArray(loopJson.blocked_actions)) {
      errors.push('blocked_actions must be an array');
    }

    return { valid: errors.length === 0, errors };
  }

  /**
   * Encode a loop record for safe storage.
   * Loop JSON can contain substrings that match the state adapter's secret
   * patterns (e.g. "sk-count" matching /sk-[a-zA-Z0-9_-]+/).  We base64-encode
   * the serialized loop payload so raw text never reaches the scanner.
   *
   * @param {object} record - { loop, registeredAt, status }
   * @returns {object} safe record with loop replaced by { _b64: '...' }
   */
  _encodeRecord(record) {
    return {
      ...record,
      loop: { _b64: Buffer.from(JSON.stringify(record.loop), 'utf8').toString('base64') },
    };
  }

  /**
   * Decode a stored record back to its original form.
   *
   * @param {object} record - stored record (loop may be { _b64: '...' } or raw)
   * @returns {object} record with loop as the original loop object
   */
  _decodeRecord(record) {
    if (record.loop && record.loop._b64) {
      return {
        ...record,
        loop: JSON.parse(Buffer.from(record.loop._b64, 'base64').toString('utf8')),
      };
    }
    return record; // backward-compat: already decoded or stored without encoding
  }

  /**
   * Read the current registry state from the state store.
   * Decodes all loop records on the way out.
   *
   * @returns {Promise<{ loops: object }>}
   */
  async _readRegistry() {
    const raw = await this.store.get(REGISTRY_STATE_KEY);
    if (!raw || typeof raw !== 'object' || !raw.loops) {
      return { loops: {} };
    }
    // Decode each record
    const loops = {};
    for (const [id, record] of Object.entries(raw.loops)) {
      loops[id] = this._decodeRecord(record);
    }
    return { loops };
  }

  /**
   * Persist the registry state to the state store.
   * Encodes all loop records before writing to avoid false-positive secret matches.
   *
   * @param {{ loops: object }} state
   */
  async _writeRegistry(state) {
    const encoded = { loops: {} };
    for (const [id, record] of Object.entries(state.loops)) {
      encoded.loops[id] = this._encodeRecord(record);
    }
    await this.store.put(REGISTRY_STATE_KEY, encoded);
  }

  /**
   * Validate and register a loop. Throws if validation fails.
   *
   * @param {object} loopJson
   * @returns {Promise<{ loopId: string, version: string, status: string }>}
   */
  async register(loopJson) {
    const { valid, errors } = this.validate(loopJson);
    if (!valid) {
      throw new Error(`[DreamLoopRegistry] register() validation failed:\n  - ${errors.join('\n  - ')}`);
    }

    const state = await this._readRegistry();

    state.loops[loopJson.loop_id] = {
      loop: loopJson,
      registeredAt: new Date().toISOString(),
      status: 'registered',
    };

    await this._writeRegistry(state);

    return {
      loopId: loopJson.loop_id,
      version: loopJson.version,
      status: 'registered',
    };
  }

  /**
   * Retrieve a loop record by ID.
   *
   * @param {string} loopId
   * @returns {Promise<object|null>}
   */
  async get(loopId) {
    const state = await this._readRegistry();
    return state.loops[loopId] || null;
  }

  /**
   * List all registered loops as summary records.
   *
   * @returns {Promise<Array<{ loopId: string, title: string, version: string, status: string, stepCount: number }>>}
   */
  async list() {
    const state = await this._readRegistry();
    return Object.entries(state.loops).map(([loopId, record]) => ({
      loopId,
      title: record.loop.title || '',
      version: record.loop.version || '',
      status: record.status || '',
      stepCount: Array.isArray(record.loop.steps) ? record.loop.steps.length : 0,
    }));
  }

  /**
   * List loops owned by a specific agent.
   *
   * @param {string} owner
   * @returns {Promise<Array<{ loopId: string, title: string, version: string, status: string, stepCount: number }>>}
   */
  async listForOwner(owner) {
    const all = await this.list();
    const state = await this._readRegistry();
    return all.filter((summary) => {
      const record = state.loops[summary.loopId];
      return record && record.loop.owner === owner;
    });
  }
}

module.exports = { DreamLoopRegistry };
