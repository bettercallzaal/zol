'use strict';

// tool-gateway.test.js
// Run: node --test src/__tests__/tool-gateway.test.js

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { ToolGateway, ApprovalRequiredError, PermissionDeniedError } = require('../tool-gateway');
const { ReceiptJournal } = require('../receipt-journal');

const makeMockStore = () => ({
  _data: {},
  async get(k) { return this._data[k]; },
  async put(k, v) { this._data[k] = JSON.parse(JSON.stringify(v)); },
  async initialize() {},
});

const mockHandler = async ({ input }) => ({ result: 'ok', input });

describe('ToolGateway', () => {
  test('register() and get() roundtrip', () => {
    const store = makeMockStore();
    const journal = new ReceiptJournal(store);
    const gw = new ToolGateway(store, journal, { agentId: 'zolbot' });

    const registerResult = gw.register({
      toolId: 'state.local.read',
      name: 'State Local Read',
      requiredPermission: 'state.local.read',
      handler: mockHandler,
    });

    assert.deepEqual(registerResult, { toolId: 'state.local.read', registered: true });

    const tool = gw.get('state.local.read');
    assert.ok(tool !== null, 'get() should return the registered tool');
    assert.equal(tool.toolId, 'state.local.read');
    assert.equal(tool.name, 'State Local Read');
    assert.equal(tool.requiredPermission, 'state.local.read');
  });

  test('list() with category filter returns only matching tools', () => {
    const store = makeMockStore();
    const journal = new ReceiptJournal(store);
    const gw = new ToolGateway(store, journal, { agentId: 'zolbot' });

    gw.register({ toolId: 'memory.write', name: 'Memory Write', requiredPermission: 'memory.write', category: 'memory', handler: mockHandler });
    gw.register({ toolId: 'state.local.read', name: 'State Read', requiredPermission: 'state.local.read', category: 'state', handler: mockHandler });

    const memoryTools = gw.list({ category: 'memory' });

    assert.ok(Array.isArray(memoryTools), 'list() should return an array');
    for (const t of memoryTools) {
      assert.equal(t.category, 'memory', `unexpected category: ${t.category}`);
    }
    const memTool = memoryTools.find((t) => t.toolId === 'memory.write');
    assert.ok(memTool, 'memory.write should appear in memory category list');

    // state tool should not appear
    const stateTool = memoryTools.find((t) => t.toolId === 'state.local.read');
    assert.ok(!stateTool, 'state.local.read should not appear in memory category filter');
  });

  test('checkPermission() with matching permission → {allowed: true}', () => {
    const store = makeMockStore();
    const journal = new ReceiptJournal(store);
    const gw = new ToolGateway(store, journal, { agentId: 'zolbot' });
    gw.register({ toolId: 'state.local.read', name: 'State Read', requiredPermission: 'state.local.read', handler: mockHandler });

    const result = gw.checkPermission('state.local.read', ['state.local.read']);

    assert.equal(result.allowed, true);
    assert.ok(typeof result.reason === 'string', 'reason should be a string');
  });

  test('checkPermission() with missing permission → {allowed: false}', () => {
    const store = makeMockStore();
    const journal = new ReceiptJournal(store);
    const gw = new ToolGateway(store, journal, { agentId: 'zolbot' });
    gw.register({ toolId: 'state.local.read', name: 'State Read', requiredPermission: 'state.local.read', handler: mockHandler });

    const result = gw.checkPermission('state.local.read', []);

    assert.equal(result.allowed, false);
    assert.ok(typeof result.reason === 'string', 'reason should be a string');
  });

  test('execute() with denied permission throws PermissionDeniedError', async () => {
    const store = makeMockStore();
    const journal = new ReceiptJournal(store);
    const gw = new ToolGateway(store, journal, { agentId: 'zolbot' });
    gw.register({ toolId: 'state.local.read', name: 'State Read', requiredPermission: 'state.local.read', handler: mockHandler });

    await assert.rejects(
      () => gw.execute('state.local.read', {}, { grantedPermissions: [] }),
      (err) => {
        assert.ok(err instanceof PermissionDeniedError, `expected PermissionDeniedError, got ${err.constructor.name}`);
        assert.equal(err.name, 'PermissionDeniedError');
        return true;
      }
    );
  });

  test('execute() requiresApproval in non-mock mode throws ApprovalRequiredError', async () => {
    const store = makeMockStore();
    const journal = new ReceiptJournal(store);
    const gw = new ToolGateway(store, journal, { agentId: 'zolbot' });
    gw.register({
      toolId: 'approval.request',
      name: 'Approval Request',
      requiredPermission: 'approval.request',
      requiresApproval: true,
      handler: mockHandler,
    });

    await assert.rejects(
      () => gw.execute('approval.request', {}, {
        grantedPermissions: ['approval.request'],
        executionMode: 'live',
      }),
      (err) => {
        assert.ok(err instanceof ApprovalRequiredError, `expected ApprovalRequiredError, got ${err.constructor.name}`);
        assert.equal(err.name, 'ApprovalRequiredError');
        return true;
      }
    );
  });

  test('execute() with isConsequential:true records receipt in journal', async () => {
    const store = makeMockStore();
    const journal = new ReceiptJournal(store);
    const gw = new ToolGateway(store, journal, { agentId: 'zolbot' });
    gw.register({
      toolId: 'state.local.write',
      name: 'State Write',
      requiredPermission: 'state.local.write',
      isConsequential: true,
      handler: mockHandler,
    });

    const { output, receiptId } = await gw.execute('state.local.write', { key: 'myval' }, {
      grantedPermissions: ['state.local.write'],
      executionMode: 'live',
      loopId: 'test-loop',
      runId: 'test-run',
      capsuleId: 'test-cap',
    });

    assert.deepEqual(output, { result: 'ok', input: { key: 'myval' } });
    assert.ok(receiptId, 'receiptId should be set for consequential tools');

    const receipt = await journal.get(receiptId);
    assert.ok(receipt, 'receipt should be retrievable from the journal');
    assert.equal(receipt.action, 'state.local.write');
    assert.equal(receipt.status, 'success');
  });

  test('discover() returns {agentId, tools: [...]}', () => {
    const store = makeMockStore();
    const journal = new ReceiptJournal(store);
    const gw = new ToolGateway(store, journal, { agentId: 'zolbot-test' });
    gw.register({ toolId: 'state.local.read', name: 'State Read', requiredPermission: 'state.local.read', handler: mockHandler });
    gw.register({ toolId: 'memory.write', name: 'Memory Write', requiredPermission: 'memory.write', handler: mockHandler });

    const discovery = gw.discover();

    assert.equal(discovery.agentId, 'zolbot-test');
    assert.ok(Array.isArray(discovery.tools), 'tools should be an array');
    assert.ok(discovery.tools.length >= 2, 'should include registered tools');
    assert.ok(typeof discovery.generatedAt === 'string', 'generatedAt should be set');
  });
});
