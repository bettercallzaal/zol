'use strict';

// src/adapters/toolgym-adapter.js
// Layer 15: Export training manifests, run bounded tool workouts, attach
// verification evidence, and record mastery receipts without self-certifying.
// CommonJS, no external dependencies.

const crypto = require('crypto');

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_MAX_ROUNDS = 3;
const DEFAULT_TIMEOUT_MS = 5000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Check whether every key in expectedOutputKeys is present in output.
 *
 * @param {object}   output
 * @param {string[]} expectedOutputKeys
 * @returns {boolean}
 */
function outputMeetsExpectations(output, expectedOutputKeys) {
  if (!output || typeof output !== 'object') return false;
  if (!Array.isArray(expectedOutputKeys) || expectedOutputKeys.length === 0) return true;
  return expectedOutputKeys.every(key => Object.prototype.hasOwnProperty.call(output, key));
}

/**
 * Compute pass-rate as a fraction 0.0–1.0.
 *
 * @param {Array<{ passed: boolean }>} results
 * @returns {number}
 */
function computePassRate(results) {
  if (!results || results.length === 0) return 0;
  const passed = results.filter(r => r.passed).length;
  return passed / results.length;
}

// ---------------------------------------------------------------------------
// ToolGymAdapter
// ---------------------------------------------------------------------------

class ToolGymAdapter {
  /**
   * @param {object} toolGateway       - ToolGateway instance (list, execute)
   * @param {object} artifactPipeline  - ArtifactPipeline instance (plan, build, verify, deliver)
   * @param {object} receiptJournal    - ReceiptJournal instance (append, list)
   * @param {object} [opts]
   * @param {string} [opts.agentId='zolbot']
   */
  constructor(toolGateway, artifactPipeline, receiptJournal, { agentId = 'zolbot' } = {}) {
    if (!toolGateway || typeof toolGateway.list !== 'function') {
      throw new Error('ToolGymAdapter: toolGateway must have a list() method');
    }
    if (!toolGateway.execute || typeof toolGateway.execute !== 'function') {
      throw new Error('ToolGymAdapter: toolGateway must have an execute() method');
    }
    if (!artifactPipeline || typeof artifactPipeline.plan !== 'function') {
      throw new Error('ToolGymAdapter: artifactPipeline must have a plan() method');
    }
    if (!receiptJournal || typeof receiptJournal.append !== 'function') {
      throw new Error('ToolGymAdapter: receiptJournal must have an append() method');
    }

    this._gateway = toolGateway;
    this._pipeline = artifactPipeline;
    this._journal = receiptJournal;
    this._agentId = agentId;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Export a training manifest listing all tools registered with the gateway.
   * Also creates a 'training-manifest' artifact in the pipeline (planned + built).
   *
   * @returns {Promise<object>} training manifest
   */
  async exportTrainingManifest() {
    const now = new Date().toISOString();
    const manifestId = `tgm_${crypto.randomUUID()}`;

    // 1. Fetch tools from the gateway
    const rawTools = this._gateway.list();

    // 2. Map to the manifest tool schema (public fields only)
    const tools = rawTools.map(t => ({
      toolId: t.toolId,
      name: t.name,
      category: t.category,
      requiredPermission: t.requiredPermission,
      inputSchema: t.inputSchema || {},
    }));

    // 3. Build manifest
    const manifest = {
      manifestId,
      version: '1.0.0',
      agentId: this._agentId,
      generatedAt: now,
      tools,
      workouts: [],
    };

    // 4. Persist as an artifact: plan → build
    const artifact = await this._pipeline.plan({
      type: 'training-manifest',
      title: `Training manifest ${manifestId}`,
      description: `Tool training manifest generated at ${now} listing ${tools.length} tool(s).`,
      tags: ['toolgym', 'training-manifest'],
    });

    await this._pipeline.build(artifact.artifactId, manifest, { format: 'json' });

    return manifest;
  }

  /**
   * Run a bounded workout for a single tool: executes the tool once per input
   * (up to maxRounds), records each result, and sets a pass/fail status.
   *
   * The tool is always called with executionMode='mock'. No real side-effects.
   *
   * @param {object}   workoutDef
   * @param {string}   workoutDef.toolId
   * @param {string}   [workoutDef.name]
   * @param {string}   [workoutDef.description]
   * @param {number}   [workoutDef.maxRounds=3]
   * @param {number}   [workoutDef.timeoutMs=5000]
   * @param {object[]} workoutDef.inputs              - test inputs to run
   * @param {string[]} [workoutDef.expectedOutputKeys=[]]
   * @param {string[]} [grantedPermissions=[]]
   * @returns {Promise<object>} completed workout result
   */
  async runWorkout(workoutDef, grantedPermissions = []) {
    // --- Validate ---
    if (!workoutDef || typeof workoutDef !== 'object') {
      throw new Error('ToolGymAdapter.runWorkout: workoutDef must be an object');
    }
    if (!workoutDef.toolId) {
      throw new Error('ToolGymAdapter.runWorkout: workoutDef.toolId is required');
    }
    if (!Array.isArray(workoutDef.inputs) || workoutDef.inputs.length === 0) {
      throw new Error('ToolGymAdapter.runWorkout: workoutDef.inputs must be a non-empty array');
    }

    const workoutId = `wkt_${crypto.randomUUID()}`;
    const maxRounds = typeof workoutDef.maxRounds === 'number' && workoutDef.maxRounds > 0
      ? workoutDef.maxRounds
      : DEFAULT_MAX_ROUNDS;
    const timeoutMs = typeof workoutDef.timeoutMs === 'number' && workoutDef.timeoutMs > 0
      ? workoutDef.timeoutMs
      : DEFAULT_TIMEOUT_MS;
    const expectedOutputKeys = Array.isArray(workoutDef.expectedOutputKeys)
      ? workoutDef.expectedOutputKeys
      : [];

    // Inputs to run: slice to maxRounds
    const inputs = workoutDef.inputs.slice(0, maxRounds);

    const results = [];
    let status = 'running';

    for (const input of inputs) {
      const startedAt = Date.now();
      let output = null;
      let passed = false;

      try {
        const execResult = await this._gateway.execute(
          workoutDef.toolId,
          input,
          {
            grantedPermissions: Array.isArray(grantedPermissions) ? grantedPermissions : [],
            executionMode: 'mock',
          }
        );
        output = execResult && execResult.output !== undefined ? execResult.output : execResult;
        passed = outputMeetsExpectations(output, expectedOutputKeys);
      } catch (err) {
        output = { error: err.message };
        passed = false;
      }

      const durationMs = Date.now() - startedAt;
      results.push({ input, output, durationMs, passed });

      // Hard time-budget guard: if this round already exceeded timeoutMs, abort
      if (durationMs >= timeoutMs) {
        break;
      }
    }

    // Overall pass requires ALL rounds to have passed
    status = results.length > 0 && results.every(r => r.passed) ? 'passed' : 'failed';

    return {
      workoutId,
      toolId: workoutDef.toolId,
      name: workoutDef.name || workoutDef.toolId,
      description: workoutDef.description || '',
      maxRounds,
      timeoutMs,
      inputs: workoutDef.inputs,
      expectedOutputKeys,
      status,
      results,
      evidence: null,
    };
  }

  /**
   * Record a mastery receipt for a tool after a passed workout.
   * Stores the receipt both as a delivered artifact and in the receipt journal.
   * Throws if the workout did not pass.
   *
   * @param {string} toolId
   * @param {object} workoutResult  - output of runWorkout()
   * @returns {Promise<object>} mastery receipt
   */
  async recordMasteryReceipt(toolId, workoutResult) {
    if (!toolId) {
      throw new Error('ToolGymAdapter.recordMasteryReceipt: toolId is required');
    }
    if (!workoutResult || workoutResult.status !== 'passed') {
      throw new Error(
        'ToolGymAdapter.recordMasteryReceipt: only passed workouts can generate mastery receipts'
      );
    }

    const receiptId = `mast_${crypto.randomUUID()}`;
    const masteredAt = new Date().toISOString();
    const passRate = computePassRate(workoutResult.results);
    const roundsCompleted = Array.isArray(workoutResult.results) ? workoutResult.results.length : 0;

    // Evidence: summarize the workout without exposing raw inputs/outputs
    const evidence = {
      workoutId: workoutResult.workoutId,
      toolId,
      passRate,
      roundsCompleted,
      expectedOutputKeys: workoutResult.expectedOutputKeys || [],
      masteredAt,
    };

    const masteryReceipt = {
      receiptId,
      toolId,
      workoutId: workoutResult.workoutId,
      agentId: this._agentId,
      masteredAt,
      passRate,
      roundsCompleted,
      evidence,
      attestedBy: 'toolgym-adapter',
    };

    // 1. Store as a full artifact: plan → build → verify → deliver
    const artifact = await this._pipeline.plan({
      type: 'training-manifest',
      title: `Mastery receipt: ${toolId} [${receiptId}]`,
      description: `Tool mastery receipt for ${toolId}, workout ${workoutResult.workoutId}. Pass rate: ${(passRate * 100).toFixed(1)}%.`,
      tags: ['toolgym', 'mastery-receipt', toolId],
      metadata: { toolId, workoutId: workoutResult.workoutId, passRate },
    });

    await this._pipeline.build(artifact.artifactId, masteryReceipt, { format: 'json' });
    await this._pipeline.verify(artifact.artifactId, { passed: true, passRate, roundsCompleted });
    await this._pipeline.deliver(artifact.artifactId);

    // 2. Append to receipt journal
    await this._journal.append({
      loopId: `toolgym:${toolId}`,
      runId: workoutResult.workoutId,
      stepId: receiptId,
      capsuleId: artifact.artifactId,
      action: 'toolgym.mastery',
      status: 'success',
      evidence,
      idempotencyKey: `${toolId}:${workoutResult.workoutId}:mastery`,
    });

    return masteryReceipt;
  }

  /**
   * List all recorded mastery receipts (training-manifest artifacts with
   * status='delivered').
   *
   * @returns {Promise<object[]>} array of artifact summaries
   */
  async listMasteryReceipts() {
    return this._pipeline.list({ type: 'training-manifest', status: 'delivered' });
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = { ToolGymAdapter };
