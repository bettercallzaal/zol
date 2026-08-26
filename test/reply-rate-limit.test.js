const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createReplyRateLimiter, DEFAULT_MAX } = require('../src/reply-rate-limit');

function tmpFile(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zol-rl-'));
  return path.join(dir, name || 'rate.json');
}

// A clock the test drives by hand - no sleeping, no wall-clock flake.
function clock(start) {
  let t = start;
  return { now: () => t, advance: ms => { t += ms; } };
}

test('default cap is 5 per hour', () => {
  assert.strictEqual(DEFAULT_MAX, 5);
  assert.strictEqual(createReplyRateLimiter({ file: tmpFile() }).max, 5);
});

test('allows exactly 5 in an hour, denies the 6th', () => {
  const c = clock(1000000);
  const rl = createReplyRateLimiter({ file: tmpFile(), now: c.now });
  for (let i = 1; i <= 5; i++) {
    const r = rl.reserve();
    assert.strictEqual(r.allowed, true, 'reply ' + i + ' should be allowed');
    assert.strictEqual(r.remaining, 5 - i);
    c.advance(60000);
  }
  const sixth = rl.reserve();
  assert.strictEqual(sixth.allowed, false);
  assert.match(sixth.reason, /rate limit 5\/hr/);
  assert.ok(sixth.retryAfterMs > 0);
});

test('window slides - a slot frees up once its hour is past', () => {
  const c = clock(1000000);
  const rl = createReplyRateLimiter({ file: tmpFile(), now: c.now });
  for (let i = 0; i < 5; i++) rl.reserve();
  assert.strictEqual(rl.reserve().allowed, false);
  c.advance(60 * 60 * 1000 + 1); // first five all age out
  assert.strictEqual(rl.reserve().allowed, true);
});

test('the cap survives a restart - state is on disk, not in memory', () => {
  const file = tmpFile();
  const c = clock(1000000);
  for (let i = 0; i < 5; i++) createReplyRateLimiter({ file, now: c.now }).reserve();
  const fresh = createReplyRateLimiter({ file, now: c.now });
  assert.strictEqual(fresh.reserve().allowed, false, 'a restart must not reset the hour');
});

test('FAILS CLOSED on corrupt state', () => {
  const file = tmpFile();
  fs.writeFileSync(file, '{not json');
  const r = createReplyRateLimiter({ file }).reserve();
  assert.strictEqual(r.allowed, false);
  assert.match(r.reason, /fail-closed/);
});

test('FAILS CLOSED on malformed state (right JSON, wrong shape)', () => {
  const file = tmpFile();
  fs.writeFileSync(file, JSON.stringify({ posted: ['not-a-timestamp'] }));
  assert.strictEqual(createReplyRateLimiter({ file }).reserve().allowed, false);
  fs.writeFileSync(file, JSON.stringify({ posted: 'nope' }));
  assert.strictEqual(createReplyRateLimiter({ file }).reserve().allowed, false);
});

test('FAILS CLOSED on an unreadable state file', () => {
  const file = tmpFile();
  fs.writeFileSync(file, JSON.stringify({ posted: [] }));
  fs.chmodSync(file, 0o000);
  const r = createReplyRateLimiter({ file }).reserve();
  fs.chmodSync(file, 0o600);
  assert.strictEqual(r.allowed, false);
  assert.match(r.reason, /fail-closed/);
});

test('FAILS CLOSED when the state cannot be written', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zol-rl-ro-'));
  const file = path.join(dir, 'rate.json');
  fs.chmodSync(dir, 0o500); // readable, not writable
  const r = createReplyRateLimiter({ file }).reserve();
  fs.chmodSync(dir, 0o700);
  assert.strictEqual(r.allowed, false);
  assert.match(r.reason, /fail-closed/);
});

test('FAILS CLOSED on a misconfigured cap', () => {
  for (const bad of ['abc', '-1', '2.5']) {
    const r = createReplyRateLimiter({ file: tmpFile(), max: bad }).reserve();
    assert.strictEqual(r.allowed, false, 'max=' + bad + ' must deny');
    assert.match(r.reason, /cap misconfigured/);
  }
});

test('a cap of 0 denies everything', () => {
  const r = createReplyRateLimiter({ file: tmpFile(), max: 0 }).reserve();
  assert.strictEqual(r.allowed, false);
});

test('cold start on a missing file is allowed, and only once per slot', () => {
  const rl = createReplyRateLimiter({ file: tmpFile('nested/deep/rate.json'), max: 1 });
  assert.strictEqual(rl.reserve().allowed, true);
  assert.strictEqual(rl.reserve().allowed, false);
});

test('state() reports usage without consuming a slot', () => {
  const c = clock(1000000);
  const rl = createReplyRateLimiter({ file: tmpFile(), now: c.now });
  rl.reserve(); rl.reserve();
  assert.deepStrictEqual(rl.state(), { used: 2, max: 5, remaining: 3 });
  assert.deepStrictEqual(rl.state(), { used: 2, max: 5, remaining: 3 });
});
