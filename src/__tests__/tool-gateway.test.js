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
  test('register() returns {registered:true}', () => {
    const store = makeMockStore();
    const journal = new ReceiptJournal(store);
    const gw = new ToolGateway(store, journal, { agentId: 'zolbot' });

    const result = gw.register({
      toolId: 'test.read',
      name: 'Test Read',
      requiredPermission: 'test.read',
      handler: mockHandler,
    });

    assert.deepEqual(result, { toolId: 'test.read', registered: true });
  });

  test('get("test.read") returns tool definition', () => {
    const store = makeMockStore();
    const journal = new ReceiptJournal(store);
    const gw = new ToolGateway(store, journal, { agentId: 'zolbot' });
    gw.register({ toolId: 'test.read', name: 'Test Read', requiredPermission: 'test.read', handler: mockHandler });

    const tool = gw.get('test.read');

    assert.ok(tool !== null, 'get() should return a tool definition');
    assert.equal(tool.toolId, 'test.read');
    assert.equal(tool.name, 'Test Read');
    assert.equal(tool.requiredPermission, 'test.read');
  });

  test('list({category:"test"}) returns tool with category "test"', () => {
    const store = makeMockStore();
    const journal = new ReceiptJournal(store);
    const gw = new ToolGateway(store, journal, { agentId: 'zolbot' });
    gw.register({
      toolId: 'test.widget',
      name: 'Test Widget',
      requiredPermission: 'test.widget',
      category: 'test',
      handler: mockHandler,
    });

    const list = gw.list({ category: 'test' });

    assert.ok(Array.isArray(list), 'list() should return an array');
    const found = list.find((t) => t.toolId === 'test.widget');
    assert.ok(found, 'tool with category "test" should appear in list');
    assert.equal(found.category, 'test');
  });

  test('checkPermission("test.read", ["test.read"]) → {allowed:true}', () => {
    const store = makeMockStore();
    const journal = new ReceiptJournal(store);
    const gw = new ToolGateway(store, journal, { agentId: 'zolbot' });
    gw.register({ toolId: 'test.read', name: 'Test Read', requiredPermission: 'test.read', handler: mockHandler });

    const result = gw.checkPermission('test.read', ['test.read']);

    assert.equal(result.allowed, true);
  });

  test('checkPermission("test.read", []) → {allowed:false}', () => {
    const store = makeMockStore();
    const journal = new ReceiptJournal(store);
    const gw = new ToolGateway(store, journal, { agentId: 'zolbot' });
    gw.register({ toolId: 'test.read', name: 'Test Read', requiredPermission: 'test.read', handler: mockHandler });

    const result = gw.checkPermission('test.read', []);

    assert.equal(result.allowed, false);
  });

  test('execute with grantedPermissions:[] throws PermissionDeniedError', async () => {
    const store = makeMockStore();
    const journal = new ReceiptJournal(store);
    const gw = new ToolGateway(store, journal, { agentId: 'zolbot' });
    gw.register({ toolId: 'test.read', name: 'Test Read', requiredPermission: 'test.read', handler: mockHandler });

    await assert.rejects(
      () => gw.execute('test.read', {}, { grantedPermissions: [] }),
      (err) => {
        assert.ok(err instanceof PermissionDeniedError, `expected PermissionDeniedError, got ${err.constructor.name}`);
        return true;
      }
    );
  });

  test('tool with requiresApproval:true in executionMode:"live" throws ApprovalRequiredError', async () => {
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
        return true;
      }
    );
  });

  test('execute consequential tool writes a receipt to the journal', async () => {
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

    const { output, receiptId } = await gw.execute('state.local.write', { key: 'v' }, {
      grantedPermissions: ['state.local.write'],
      executionMode: 'live',
      loopId: 'test-loop',
      runId: 'test-run',
      capsuleId: 'test-cap',
    });

    assert.deepEqual(output, { result: 'ok', input: { key: 'v' } });
    assert.ok(receiptId, 'receiptId should be set for consequential tools');

    // Verify the receipt exists in the journal
    const receipt = await journal.get(receiptId);
    assert.ok(receipt, 'receipt should exist in the journal');
    assert.equal(receipt.action, 'state.local.write');
    assert.equal(receipt.status, 'success');
  });
});
