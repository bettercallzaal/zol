// reply-rate-limit.js - hard cap on how many replies ZOL may post per rolling hour.
//
// FAILS CLOSED. Every failure mode denies the reply rather than allowing it:
//   - state file exists but is unreadable       -> deny
//   - state file is corrupt or malformed JSON   -> deny
//   - the cap itself is misconfigured           -> deny
//   - the write or the read-back verify fails   -> deny
// The one path that allows on a missing file is cold start (ENOENT), otherwise
// the limiter could never issue a first reply.
//
// A denied reply is never lost: the caller stages the draft for manual approval,
// so the cap throttles autonomous posting without dropping the mention.
const fs = require('fs');
const path = require('path');

const WINDOW_MS = 60 * 60 * 1000;
const DEFAULT_MAX = 5;

function parseMax(raw, fallback) {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) return null; // unparseable cap -> reserve() denies
  return n;
}

function createReplyRateLimiter(opts = {}) {
  const file = opts.file;
  if (!file) throw new Error('reply-rate-limit: file is required');
  const windowMs = opts.windowMs || WINDOW_MS;
  const now = opts.now || (() => Date.now());
  const max = parseMax(opts.max, DEFAULT_MAX);

  function load() {
    let raw;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch (e) {
      if (e && e.code === 'ENOENT') return []; // cold start is the only allowed absence
      throw new Error('state unreadable: ' + ((e && e.code) || (e && e.message) || e));
    }
    const parsed = JSON.parse(raw); // throws on corruption -> denied
    if (!parsed || !Array.isArray(parsed.posted)) throw new Error('state malformed');
    for (const ts of parsed.posted) {
      if (typeof ts !== 'number' || !Number.isFinite(ts)) throw new Error('state malformed');
    }
    return parsed.posted;
  }

  function save(posted) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ posted }), 'utf8');
    fs.renameSync(tmp, file); // atomic swap, no half-written state
    const back = JSON.parse(fs.readFileSync(file, 'utf8')); // verify it actually landed
    if (!back || !Array.isArray(back.posted) || back.posted.length !== posted.length) {
      throw new Error('state did not persist');
    }
  }

  // Reserve a slot BEFORE the network call. If the post then crashes mid-flight,
  // the slot is spent - which costs one reply, versus handing out a free retry.
  function reserve() {
    try {
      if (max === null) return deny('cap misconfigured', windowMs);
      const t = now();
      const posted = load().filter(ts => t - ts < windowMs);
      if (posted.length >= max) {
        const retry = posted.length ? Math.max(0, windowMs - (t - Math.min(...posted))) : 0;
        return deny('rate limit ' + max + '/hr reached', retry);
      }
      posted.push(t);
      save(posted);
      return { allowed: true, reason: 'ok', used: posted.length, max, remaining: max - posted.length, retryAfterMs: 0 };
    } catch (e) {
      return deny('fail-closed: ' + ((e && e.message) || e), windowMs);
    }
  }

  function deny(reason, retryAfterMs) {
    return { allowed: false, reason, used: null, max, remaining: 0, retryAfterMs };
  }

  function state() {
    try {
      const t = now();
      const used = load().filter(ts => t - ts < windowMs).length;
      return { used, max, remaining: max === null ? 0 : Math.max(0, max - used) };
    } catch (e) {
      return { used: null, max, remaining: 0, error: (e && e.message) || String(e) };
    }
  }

  return { reserve, state, max, windowMs, file };
}

module.exports = { createReplyRateLimiter, WINDOW_MS, DEFAULT_MAX };
