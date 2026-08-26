// Guards on the reply daemon's shape. It cannot be imported - requiring it starts an
// infinite polling loop - so these assert against the source: it parses, the behaviour
// changes of 2026-08-26 are present, and the safety filters that predate them survive.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const FILE = path.join(__dirname, '..', 'scripts', 'zol-reply.js');
const src = fs.readFileSync(FILE, 'utf8');

test('zol-reply.js parses', () => {
  assert.doesNotThrow(() => new vm.Script(src, { filename: FILE }));
});

test('the fid 19640 skip is gone - ZOL answers Zaal', () => {
  // The changelog comment names the fid, so match the comparison, not the number.
  assert.ok(!/pfid\s*===\s*19640/.test(src), 'the fid 19640 comparison is what blocked Zaal tags');
  assert.ok(!/\b19640\b/.test(src.replace(/\/\/.*$/gm, '')), 'fid 19640 must not survive outside a comment');
});

test('the self-loop guard replaced it', () => {
  assert.match(src, /if\(pfid===FID\)\{continue;\}/);
});

test('replies go through the rate limiter', () => {
  assert.match(src, /require\('\.\.\/src\/reply-rate-limit'\)/);
  assert.match(src, /RL\.reserve\(\)/);
});

test('the slot is reserved BEFORE the post, not after', () => {
  const reserve = src.indexOf('RL.reserve()');
  const post = src.indexOf('await L.post(');
  assert.ok(reserve > -1 && post > -1, 'both the reserve and the post must exist');
  assert.ok(reserve < post, 'reserving after posting would hand out a free retry on a crash');
});

test('a refused reply is staged, never dropped', () => {
  assert.match(src, /if\(!slot\.allowed\)\{/);
  assert.match(src, /post-reply\.js/, 'the held draft must come with a way to post it by hand');
  const write = src.indexOf('fs.writeFileSync(dp,');
  assert.ok(write > -1 && write < src.indexOf('RL.reserve()'), 'the draft must be on disk before the limiter can refuse it');
});

test('ZOL_AUTOREPLY=0 falls back to stage-only', () => {
  assert.match(src, /ZOL_AUTOREPLY!=='0'/);
});

test('the pre-existing safety filters survive', () => {
  assert.match(src, /BLOCK\.has\(pfid\)/, 'bot blocklist');
  assert.match(src, /mfids\.some\(f=>BLOCK\.has\(f\)\)/, 'double-tag guard');
  assert.match(src, /replace\(\/@\(\\w\)\/g,'\$1'\)/, 'no-tag output');
});
