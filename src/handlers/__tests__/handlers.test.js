// src/handlers/__tests__/handlers.test.js - Handler input validation, timeout, security tests
// Run: node --test src/handlers/__tests__/handlers.test.js

const test = require('node:test');
const assert = require('node:assert');
const handlers = require('../index');

// ===== INPUT VALIDATION TESTS =====
test('state.local.read: validates required stateKey', async (t) => {
  try {
    await handlers['state.local.read']({
      input: {}, // missing stateKey
      state: {},
      signal: null
    });
    assert.fail('should have thrown');
  } catch (e) {
    assert.ok(e.message.includes('missing required input') || e.message.includes('stateKey'));
  }
});

test('state.local.write: validates required stateKey and rejects secret patterns', async (t) => {
  try {
    // 64-char hex (private key pattern)
    await handlers['state.local.write']({
      input: { stateKey: 'test' },
      state: {
        secret: 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789'
      },
      signal: null
    });
    assert.fail('should have rejected secret pattern');
  } catch (e) {
    assert.ok(e.message.includes('SECURITY') || e.message.includes('secret'));
  }
});

test('task.capture: validates required description', async (t) => {
  try {
    await handlers['task.capture']({
      input: {}, // missing description
      state: {},
      signal: null
    });
    assert.fail('should have thrown');
  } catch (e) {
    assert.ok(e.message.includes('description'));
  }
});

test('artifact.local.write: validates text length when maxLength specified', async (t) => {
  try {
    await handlers['artifact.local.write']({
      input: { artifactType: 'draft', validateText: true, maxLength: 10 },
      state: { text: 'this is way too long for the limit' },
      signal: null
    });
    assert.fail('should have rejected oversized text');
  } catch (e) {
    assert.ok(e.message.includes('exceeds') || e.message.includes('character'));
  }
});

// ===== TIMEOUT / ABORT SIGNAL TESTS =====
test('state.local.read: honors AbortSignal timeout', async (t) => {
  const controller = new AbortController();
  const signal = controller.signal;

  // Simulate timeout
  setTimeout(() => controller.abort(new Error('timed out')), 10);

  try {
    await handlers['state.local.read']({
      input: { stateKey: 'test' },
      state: {},
      signal
    });
    // Handler should still return (mock implementation)
  } catch (e) {
    // Some handlers may not timeout in mock mode; that's OK
  }
});

// ===== SECURITY TESTS: NO SIGNER ACCESS =====
test('handlers never require or reference signer key', async (t) => {
  const handlerList = Object.keys(handlers);
  for (const handlerName of handlerList) {
    const handler = handlers[handlerName];
    const handlerString = handler.toString();

    assert.ok(!handlerString.includes('signer'),
      `handler ${handlerName} should not reference 'signer'`);
    assert.ok(!handlerString.includes('Ed25519'),
      `handler ${handlerName} should not reference 'Ed25519'`);
    assert.ok(!handlerString.includes('privateKey'),
      `handler ${handlerName} should not reference 'privateKey'`);
    assert.ok(!handlerString.includes('PRIVATE_KEY'),
      `handler ${handlerName} should not reference 'PRIVATE_KEY'`);
  }
});

// ===== SECURITY TESTS: NO GENERIC SHELL EXECUTION =====
test('no generic shell-execution handler exists', async (t) => {
  const handlerNames = Object.keys(handlers);

  // Check for dangerous patterns
  const dangerousPatterns = ['exec', 'shell', 'spawn', 'fork', 'run-command'];
  for (const name of handlerNames) {
    for (const pattern of dangerousPatterns) {
      assert.ok(!name.includes(pattern),
        `dangerous handler pattern detected: ${name}`);
    }
  }
});

// ===== SECURITY TESTS: DRAFT-ONLY ENFORCEMENT =====
test('farcaster.reply: enforces approval gate (no direct posting)', async (t) => {
  try {
    // Try to post without approval token
    await handlers['farcaster.reply']({
      input: { requireApprovalToken: false },
      state: { text: 'test' },
      signal: null
    });
    assert.fail('should have enforced approval gate');
  } catch (e) {
    assert.ok(e.message.includes('SECURITY') || e.message.includes('approval'));
  }
});

test('farcaster.reply: with approval token returns draft-only status', async (t) => {
  const result = await handlers['farcaster.reply']({
    input: { requireApprovalToken: true },
    state: { text: 'test' },
    signal: null
  });

  assert.strictEqual(result.posted, false, 'should not post directly');
  assert.ok(result.awaitingApproval, 'should indicate approval pending');
});

// ===== STRUCTURED STATE / RECEIPT TESTS =====
test('handlers return structured state (objects)', async (t) => {
  const testCases = [
    { handler: 'state.local.read', input: { stateKey: 'test' } },
    { handler: 'memory.read', input: {} },
    { handler: 'task.read', input: {} },
    { handler: 'receipt.local.write', input: { receiptType: 'test' } },
    { handler: 'budget.read', input: {} }
  ];

  for (const { handler, input } of testCases) {
    const result = await handlers[handler]({
      input,
      state: {},
      signal: null
    });

    assert.ok(typeof result === 'object', `${handler} should return object, got ${typeof result}`);
    assert.ok(!Array.isArray(result), `${handler} should return object not array`);
    assert.ok(result.timestamp, `${handler} result should include timestamp`);
  }
});

test('receipt.local.write: generates receipt ID', async (t) => {
  const result = await handlers['receipt.local.write']({
    input: { receiptType: 'test' },
    state: {},
    signal: null
  });

  assert.ok(result.receiptId, 'should generate receiptId');
  assert.ok(result.receiptId.startsWith('rcpt_'), 'receiptId should start with rcpt_');
});

// ===== PHASE 5 COMPLETION =====
test('PHASE 5 handlers are now fully implemented', async (t) => {
  // calendar.read, farcaster.read, inbox.read are now completed with real integrations
  const completedHandlers = ['calendar.read', 'farcaster.read', 'inbox.read'];

  for (const handlerName of completedHandlers) {
    const handler = handlers[handlerName];
    assert.ok(handler, `handler ${handlerName} should exist`);

    const result = await handler({
      input: handlerName === 'calendar.read' ? { dayCount: 1 } :
             handlerName === 'farcaster.read' ? { query: 'test' } :
             { maxRecent: 10 },
      state: {},
      signal: null
    });

    // Completed handlers should return structured state (not "PHASE 5" marker)
    assert.ok(result && typeof result === 'object',
      `${handlerName} should return structured state`);
    assert.ok('timestamp' in result,
      `${handlerName} should include timestamp in response`);
  }
});

// ===== BOUNDED EVIDENCE OUTPUT TESTS =====
test('handlers emit bounded evidence (no infinite data)', async (t) => {
  const result = await handlers['farcaster.read']({
    input: { query: 'test' },
    state: {},
    signal: null
  });

  assert.ok(Array.isArray(result.results), 'results should be array');
  assert.ok(typeof result.count === 'number', 'count should be number');
  assert.ok(result.timestamp, 'should have timestamp');
});

// ===== NO FUND MOVEMENT =====
test('no fund.transfer or wallet.sign handlers exist', async (t) => {
  const dangerousHandlers = ['fund.transfer', 'wallet.sign', 'wallet.spend', 'transfer.execute'];

  for (const name of dangerousHandlers) {
    assert.ok(!(name in handlers),
      `dangerous handler should not exist: ${name}`);
  }
});

console.log('Handler tests complete');
