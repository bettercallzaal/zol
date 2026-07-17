'use strict';

// toolgym-adapter.test.js
// Run: node --test src/__tests__/toolgym-adapter.test.js

const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');

const { ToolGymAdapter } = require('../adapters/toolgym-adapter');

const makeMockStore = () => ({
  _data: {},
  async get(k) { return this._data[k]; },
  async put(k, v) { this._data[k] = JSON.parse(JSON.stringify(v)); },
  async initialize() {},
});

// Build a minimal ToolGateway mock with a single tool
function makeToolGateway(opts = {}) {
  const { throwOnExecute = false, executeFn } = opts;

  return {
    list() {
      return [
        {
          toolId: 'tool_test',
          name: 'test-tool',
          category: 'other',
          requiredPermission: 'state.local.read',
          inputSchema: {},
        },
      ];
    },
    async execute(toolId, input, execOpts) {
      if (throwOnExecute) {
        throw new Error('tool execution failed');
      }
      if (typeof executeFn === 'function') {
        return executeFn(toolId, input, execOpts);
      }
      return { output: { result: 'ok' } };
    },
  };
}

// Minimal ArtifactPipeline mock that satisfies ToolGymAdapter's needs
function makeArtifactPipeline() {
  const { ArtifactPipeline } = require('../artifact-pipeline');
  const journal = {
    async append(f) { return { receiptId: 'rcpt_test', ...f }; },
  };
  return new ArtifactPipeline(makeMockStore(), journal);
}

// Minimal ReceiptJournal mock
function makeReceiptJournal() {
  const appended = [];
  return {
    async append(f) {
      const receipt = { receiptId: `r_${Date.now()}`, ...f };
      appended.push(receipt);
      return receipt;
    },
    async list() { return [...appended]; },
    _appended: appended,
  };
}

describe('ToolGymAdapter', () => {
  test('exportTrainingManifest() returns manifest with tools array', async () => {
    const adapter = new ToolGymAdapter(
      makeToolGateway(),
      makeArtifactPipeline(),
      makeReceiptJournal()
    );

    const manifest = await adapter.exportTrainingManifest();

    assert.ok(manifest, 'manifest should be returned');
    assert.ok(manifest.manifestId, 'manifestId should be set');
    assert.ok(Array.isArray(manifest.tools), 'tools should be an array');
    assert.ok(manifest.tools.length > 0, 'tools array should be non-empty');
    assert.ok(manifest.tools[0].toolId, 'tool should have toolId');
  });

  test('runWorkout() with a mock tool that returns { result: "ok" } → status "passed"', async () => {
    const adapter = new ToolGymAdapter(
      makeToolGateway(),
      makeArtifactPipeline(),
      makeReceiptJournal()
    );

    const workout = await adapter.runWorkout({
      toolId: 'tool_test',
      name: 'Test Workout',
      inputs: [{ query: 'hello' }],
      expectedOutputKeys: ['result'],
    });

    assert.equal(workout.status, 'passed');
    assert.ok(Array.isArray(workout.results), 'results should be an array');
    assert.ok(workout.results.length > 0);
    assert.equal(workout.results[0].passed, true);
  });

  test('runWorkout() with a tool that throws → status "failed"', async () => {
    const adapter = new ToolGymAdapter(
      makeToolGateway({ throwOnExecute: true }),
      makeArtifactPipeline(),
      makeReceiptJournal()
    );

    const workout = await adapter.runWorkout({
      toolId: 'tool_test',
      name: 'Failing Workout',
      inputs: [{ query: 'will throw' }],
    });

    assert.equal(workout.status, 'failed');
    assert.ok(workout.results.length > 0);
    assert.equal(workout.results[0].passed, false);
    assert.ok(workout.results[0].output.error, 'error should be recorded in output');
  });

  test('recordMasteryReceipt() on passed workout → returns masteryReceipt with passRate', async () => {
    const adapter = new ToolGymAdapter(
      makeToolGateway(),
      makeArtifactPipeline(),
      makeReceiptJournal()
    );

    const workout = await adapter.runWorkout({
      toolId: 'tool_test',
      name: 'Mastery Workout',
      inputs: [{ query: 'test' }],
      expectedOutputKeys: ['result'],
    });

    assert.equal(workout.status, 'passed', 'workout must pass to record mastery');

    const masteryReceipt = await adapter.recordMasteryReceipt('tool_test', workout);

    assert.ok(masteryReceipt, 'masteryReceipt should be returned');
    assert.ok(masteryReceipt.receiptId, 'receiptId should be set');
    assert.equal(masteryReceipt.toolId, 'tool_test');
    assert.ok(typeof masteryReceipt.passRate === 'number', 'passRate should be a number');
    assert.ok(masteryReceipt.passRate >= 0 && masteryReceipt.passRate <= 1, 'passRate should be between 0 and 1');
  });
});
