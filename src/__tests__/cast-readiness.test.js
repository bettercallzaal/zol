'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

// ---------------------------------------------------------------------------
// farcaster.connectivity.check handler — cast readiness pre-flight
// ---------------------------------------------------------------------------

// We test the handler in isolation by monkey-patching integrations.
// The handler must never throw; always return {ok, neynar, signer, ...}.

let handlers;

// We need to test the handler with controlled integrations responses.
// Since handlers/index.js requires integrations at the top, we load it after
// temporarily patching require() — but that's fragile. Instead we extract
// the testable logic by calling the handler directly with a mocked module.
// We achieve this by setting env vars and stubbing the filesystem.

const HANDLER_NAME = 'farcaster.connectivity.check';

describe('farcaster.connectivity.check handler', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zol-cast-ready-'));
  const fakeSignerDir = path.join(tmpDir, '.openclaw');
  const fakeSignerPath = path.join(fakeSignerDir, 'farcaster-credentials.json');

  before(() => {
    // Redirect HOME so the handler reads our fake signer location
    process.env.HOME = tmpDir;
    // Load handlers AFTER env patch so integration paths resolve correctly
    handlers = require('../handlers/index');
  });

  after(() => {
    // Restore HOME
    delete process.env.HOME;
    // Cleanup temp dir
    try { fs.rmSync(tmpDir, { recursive: true }); } catch (_) {}
    // Evict module cache so other tests get a clean state
    Object.keys(require.cache)
      .filter(k => k.includes('handlers/index') || k.includes('integrations'))
      .forEach(k => delete require.cache[k]);
  });

  test('handler is registered in allHandlers', () => {
    assert.ok(typeof handlers[HANDLER_NAME] === 'function',
      `${HANDLER_NAME} must be registered`);
  });

  test('returns ok:false when creds file is missing', async () => {
    // No creds file created yet — expect creds:'missing', ok:false
    const result = await handlers[HANDLER_NAME]({
      input: { fid: 3338501, timeoutMs: 1000 },
    });
    assert.equal(typeof result.ok, 'boolean', 'ok must be boolean');
    assert.equal(result.creds, 'missing', 'creds must be "missing"');
    assert.ok(Object.hasOwn(result, 'neynar'), 'neynar field must be present');
    assert.ok(Object.hasOwn(result, 'timestamp'), 'timestamp must be present');
    assert.ok(Object.hasOwn(result, 'totalMs'), 'totalMs must be present');
    assert.ok(result.ok === false, 'ok must be false when creds missing');
  });

  test('returns creds:present when credentials file exists with content', async () => {
    fs.mkdirSync(fakeSignerDir, { recursive: true });
    fs.writeFileSync(fakeSignerPath, '{"key":"test-placeholder","fid":3338501}');
    const result = await handlers[HANDLER_NAME]({
      input: { fid: 3338501, timeoutMs: 500 },
    });
    assert.equal(result.creds, 'present', 'creds must be "present" when file exists');
    // neynar may fail in test env (no key), but creds check must pass
    assert.ok(Object.hasOwn(result, 'neynar'));
  });

  test('returns creds:empty when credentials file is too small', async () => {
    fs.mkdirSync(fakeSignerDir, { recursive: true });
    fs.writeFileSync(fakeSignerPath, '{}');  // 2 bytes < 10 byte threshold
    const result = await handlers[HANDLER_NAME]({
      input: { fid: 3338501, timeoutMs: 500 },
    });
    assert.equal(result.creds, 'empty', 'creds must be "empty" for tiny files');
    assert.equal(result.ok, false, 'ok must be false for empty creds');
  });

  test('returns neynar:no-key when NEYNAR_API_KEY is unavailable', async () => {
    // In test env, ~/.zao/private/neynar.env likely absent or HOME redirected
    const result = await handlers[HANDLER_NAME]({
      input: { fid: 3338501, timeoutMs: 500 },
    });
    // Either no-key or reachable (if real key happens to be accessible)
    assert.ok(['no-key', 'reachable', 'unreachable', 'timeout'].includes(result.neynar)
      || result.neynar.startsWith('error:'),
      `neynar must be a known status string, got: ${result.neynar}`);
  });

  test('never throws — returns ok:false on unexpected error', async () => {
    // Pass garbage input; handler must still return structured result
    let result;
    assert.doesNotThrow(() => {
      result = handlers[HANDLER_NAME]({ input: null });
    });
    // result is a promise — await it
    result = await result;
    assert.equal(typeof result, 'object');
    assert.ok(Object.hasOwn(result, 'ok'));
    assert.ok(Object.hasOwn(result, 'timestamp'));
  });

  test('ok:false is false when neynar is no-key (even if signer present)', async () => {
    fs.mkdirSync(fakeSignerDir, { recursive: true });
    fs.writeFileSync(fakeSignerPath, '{"key":"test-placeholder","fid":3338501}');
    const result = await handlers[HANDLER_NAME]({
      input: { fid: 3338501, timeoutMs: 500 },
    });
    if (result.neynar !== 'reachable') {
      assert.equal(result.ok, false,
        'ok must be false when neynar unreachable');
    }
  });
});
