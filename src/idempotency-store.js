'use strict';
// IdempotencyStore — tracks outbound/write tool call results by caller-supplied key.
// A key seen within its TTL window returns the first result without re-executing.
// Backed by in-memory map + optional atomic-file persistence for restart durability.
//
// Usage:
//   const store = new IdempotencyStore({ dir: '/path/to/state' });
//   await store.init();
//   const hit = store.check(key);          // null or { result, cachedAt }
//   store.store(key, result, ttlMs);       // idempotent write
//   await store.persist();                 // optional flush to file
//   store.prune();                         // remove expired entries

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;   // prune every hour

class IdempotencyStore {
  constructor({ dir = null, ttlMs = DEFAULT_TTL_MS } = {}) {
    this._dir = dir;
    this._defaultTtl = ttlMs;
    this._map = new Map();         // key -> { result, cachedAt, expiresAt }
    this._dirty = false;
    this._lastPrune = Date.now();
    this._file = dir ? path.join(dir, 'idempotency-store.json') : null;
  }

  async init() {
    if (!this._file) return;
    try {
      const raw = fs.readFileSync(this._file, 'utf8');
      const entries = JSON.parse(raw);
      const now = Date.now();
      for (const [key, entry] of Object.entries(entries)) {
        if (entry.expiresAt > now) {
          this._map.set(key, entry);
        }
      }
    } catch {
      // fresh start — no file yet
    }
  }

  // Returns { result, cachedAt } if key is present and not expired, null otherwise.
  check(key) {
    if (!key) return null;
    this._maybePrune();
    const entry = this._map.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this._map.delete(key);
      this._dirty = true;
      return null;
    }
    return { result: entry.result, cachedAt: entry.cachedAt };
  }

  // Store result under key with optional TTL override.
  store(key, result, ttlMs = this._defaultTtl) {
    if (!key) return;
    const now = Date.now();
    this._map.set(key, {
      result,
      cachedAt: new Date(now).toISOString(),
      expiresAt: now + ttlMs,
    });
    this._dirty = true;
  }

  // Remove expired entries.
  prune() {
    const now = Date.now();
    for (const [key, entry] of this._map) {
      if (entry.expiresAt <= now) {
        this._map.delete(key);
        this._dirty = true;
      }
    }
    this._lastPrune = now;
  }

  // Flush to file if dirty. Atomic write via temp file rename.
  async persist() {
    if (!this._file || !this._dirty) return;
    const entries = {};
    for (const [key, entry] of this._map) {
      entries[key] = entry;
    }
    const tmp = this._file + '.tmp.' + crypto.randomBytes(4).toString('hex');
    fs.writeFileSync(tmp, JSON.stringify(entries, null, 2), 'utf8');
    fs.renameSync(tmp, this._file);
    this._dirty = false;
  }

  // Number of live (non-expired) entries.
  get size() {
    this._maybePrune();
    return this._map.size;
  }

  _maybePrune() {
    if (Date.now() - this._lastPrune > PRUNE_INTERVAL_MS) this.prune();
  }
}

module.exports = { IdempotencyStore, DEFAULT_TTL_MS };
