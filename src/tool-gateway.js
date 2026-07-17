'use strict';

// tool-gateway.js - Typed tool registry, capability discovery, permission checks,
// approval requirements, health status, and receipts for ZOL Persistent Agent v2.
// Layer 8 of the ZOL upgrade stack.
// CommonJS, no external dependencies.

const crypto = require('crypto');

// ---------------------------------------------------------------------------
// Custom Errors
// ---------------------------------------------------------------------------

class ApprovalRequiredError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ApprovalRequiredError';
  }
}

class PermissionDeniedError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PermissionDeniedError';
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VALID_CATEGORIES = new Set([
  'state', 'memory', 'task', 'model', 'artifact', 'receipt',
  'relationship', 'approval', 'warper', 'toolgym', 'proof-drop', 'other',
]);

/**
 * Derive category from handler/tool name prefix.
 * e.g. "state.local.read" -> "state", "budget.read" -> "model"
 */
function categoryFromName(name) {
  const prefix = name.split('.')[0];
  if (VALID_CATEGORIES.has(prefix)) return prefix;
  if (prefix === 'budget') return 'model';
  return 'other';
}

/**
 * Determine if a tool name represents a consequential operation.
 * Consequential = involves writes, captures, approval flows, or expiry.
 */
function isConsequentialFromName(name) {
  return (
    name.includes('.write') ||
    name.includes('.capture') ||
    name.includes('approval.') ||
    name.includes('.expire')
  );
}

/**
 * Validate a tool definition object for explicit register() calls.
 * Throws if required fields are missing or invalid.
 */
function validateToolDef(toolDef) {
  if (!toolDef || typeof toolDef !== 'object') {
    throw new Error('tool definition must be an object');
  }
  if (!toolDef.toolId || typeof toolDef.toolId !== 'string') {
    throw new Error('toolDef.toolId is required and must be a string');
  }
  if (!toolDef.name || typeof toolDef.name !== 'string') {
    throw new Error('toolDef.name is required and must be a string');
  }
  if (!toolDef.requiredPermission || typeof toolDef.requiredPermission !== 'string') {
    throw new Error('toolDef.requiredPermission is required and must be a string');
  }
}

// ---------------------------------------------------------------------------
// ToolGateway
// ---------------------------------------------------------------------------

class ToolGateway {
  /**
   * @param {object} stateStore       - state-adapter store (get/put async API)
   * @param {object|null} receiptJournal - ReceiptJournal instance (may be null)
   * @param {object} [opts]
   * @param {string} [opts.agentId="zolbot"]
   * @param {object} [handlers={}]    - optional map of handler functions to auto-register
   */
  constructor(stateStore, receiptJournal, opts = {}, handlers = {}) {
    this._store = stateStore;
    this._journal = receiptJournal || null;
    this._agentId = (opts && opts.agentId) || 'zolbot';

    // Tool registry: toolId -> toolDef
    this._tools = new Map();

    // Auto-register handlers passed as 4th positional arg
    if (handlers && typeof handlers === 'object') {
      this._autoRegisterHandlers(handlers);
    }

    // Also support handlers passed inside opts (backwards compat)
    if (opts && opts.handlers && typeof opts.handlers === 'object') {
      this._autoRegisterHandlers(opts.handlers);
    }
  }

  // -------------------------------------------------------------------------
  // Private: auto-registration
  // -------------------------------------------------------------------------

  _autoRegisterHandlers(handlersMap) {
    for (const [handlerName, handlerFn] of Object.entries(handlersMap)) {
      if (typeof handlerFn !== 'function') continue;

      // toolId = handler name key directly (e.g. 'state.local.read')
      const toolId = handlerName;
      const category = categoryFromName(handlerName);

      const toolDef = {
        toolId,
        name: handlerName,
        description: `Auto-registered handler: ${handlerName}`,
        category,
        requiredPermission: toolId,
        requiresApproval: toolId === 'approval.request',
        isConsequential: isConsequentialFromName(toolId),
        inputSchema: {},
        outputSchema: {},
        handler: handlerFn,
        healthy: true,
        lastHealthCheck: null,
        version: '1.0.0',
      };

      this._tools.set(toolId, toolDef);
    }
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Register a tool definition.
   * Validates required fields: toolId, name, requiredPermission.
   * @param {object} toolDef
   * @returns {{ toolId: string, registered: true }}
   */
  register(toolDef) {
    validateToolDef(toolDef);

    const entry = {
      toolId: toolDef.toolId,
      name: toolDef.name,
      description: toolDef.description || '',
      category: toolDef.category || categoryFromName(toolDef.toolId),
      requiredPermission: toolDef.requiredPermission,
      requiresApproval: typeof toolDef.requiresApproval === 'boolean'
        ? toolDef.requiresApproval
        : toolDef.toolId === 'approval.request',
      isConsequential: typeof toolDef.isConsequential === 'boolean'
        ? toolDef.isConsequential
        : isConsequentialFromName(toolDef.toolId),
      inputSchema: toolDef.inputSchema || {},
      outputSchema: toolDef.outputSchema || {},
      handler: toolDef.handler !== undefined ? toolDef.handler : null,
      healthy: typeof toolDef.healthy === 'boolean' ? toolDef.healthy : true,
      lastHealthCheck: toolDef.lastHealthCheck || null,
      version: toolDef.version || '1.0.0',
    };

    this._tools.set(toolDef.toolId, entry);
    return { toolId: toolDef.toolId, registered: true };
  }

  /**
   * Get a tool definition clone by toolId.
   * @param {string} toolId
   * @returns {object|null}
   */
  get(toolId) {
    const tool = this._tools.get(toolId);
    if (!tool) return null;
    return Object.assign({}, tool);
  }

  /**
   * List tool summaries, optionally filtered.
   * @param {object} [opts]
   * @param {string} [opts.category]
   * @param {string} [opts.requiredPermission]
   * @returns {object[]}
   */
  list(opts = {}) {
    const { category, requiredPermission } = opts;
    const results = [];

    for (const tool of this._tools.values()) {
      if (category && tool.category !== category) continue;
      if (requiredPermission && tool.requiredPermission !== requiredPermission) continue;

      results.push({
        toolId: tool.toolId,
        name: tool.name,
        category: tool.category,
        requiredPermission: tool.requiredPermission,
        requiresApproval: tool.requiresApproval,
        isConsequential: tool.isConsequential,
        healthy: tool.healthy,
      });
    }

    return results;
  }

  /**
   * Discover all tools registered with this gateway.
   * @returns {{ agentId: string, generatedAt: string, tools: object[] }}
   */
  discover() {
    return {
      agentId: this._agentId,
      generatedAt: new Date().toISOString(),
      tools: this.list(),
    };
  }

  /**
   * Check if a tool can be called with the given permissions.
   * @param {string} toolId
   * @param {string[]} [grantedPermissions=[]]
   * @returns {{ allowed: boolean, reason: string }}
   */
  checkPermission(toolId, grantedPermissions = []) {
    const tool = this._tools.get(toolId);
    if (!tool) {
      return { allowed: false, reason: `tool "${toolId}" not found` };
    }

    const granted = Array.isArray(grantedPermissions) ? grantedPermissions : [];

    if (granted.includes(tool.requiredPermission)) {
      return { allowed: true, reason: 'permission granted' };
    }

    return {
      allowed: false,
      reason: `missing permission "${tool.requiredPermission}"`,
    };
  }

  /**
   * Run a health check on a single tool by invoking its handler in mock mode.
   * Updates healthy status and lastHealthCheck timestamp.
   * Persists health results to stateStore under 'tool-gateway-health'.
   * @param {string} toolId
   * @returns {Promise<{ toolId: string, healthy: boolean, checkedAt: string }>}
   */
  async healthCheck(toolId) {
    const tool = this._tools.get(toolId);
    if (!tool) {
      throw new Error(`healthCheck: tool "${toolId}" not found`);
    }

    const checkedAt = new Date().toISOString();
    let healthy = false;

    if (typeof tool.handler === 'function') {
      try {
        await tool.handler({
          input: {},
          state: {},
          executionMode: 'mock',
          signal: AbortSignal.timeout(3000),
        });
        healthy = true;
      } catch (_err) {
        healthy = false;
      }
    }

    tool.healthy = healthy;
    tool.lastHealthCheck = checkedAt;

    // Persist health state
    if (this._store) {
      try {
        const existing = await this._store.get('tool-gateway-health') || {};
        existing[toolId] = { healthy, checkedAt };
        await this._store.put('tool-gateway-health', existing);
      } catch (_err) {
        // Non-fatal: health check still returns result even if persist fails
      }
    }

    return { toolId, healthy, checkedAt };
  }

  /**
   * Run health checks on all registered tools sequentially.
   * @returns {Promise<{ total: number, healthy: number, unhealthy: number, results: object[] }>}
   */
  async healthCheckAll() {
    const toolIds = [...this._tools.keys()];
    const results = [];
    let healthyCount = 0;
    let unhealthyCount = 0;

    for (const toolId of toolIds) {
      const result = await this.healthCheck(toolId);
      results.push({ toolId: result.toolId, healthy: result.healthy });
      if (result.healthy) {
        healthyCount++;
      } else {
        unhealthyCount++;
      }
    }

    return {
      total: toolIds.length,
      healthy: healthyCount,
      unhealthy: unhealthyCount,
      results,
    };
  }

  /**
   * Execute a tool.
   * @param {string} toolId
   * @param {object} input
   * @param {object} [opts]
   * @param {string[]} [opts.grantedPermissions=[]]
   * @param {string}   [opts.executionMode="mock"]
   * @param {string}   [opts.runId="unknown"]
   * @param {string}   [opts.loopId="unknown"]
   * @param {string}   [opts.capsuleId="unknown"]
   * @returns {Promise<{ output: object, receiptId: string|null }>}
   */
  async execute(toolId, input, opts = {}) {
    const {
      grantedPermissions = [],
      executionMode = 'mock',
      runId = 'unknown',
      loopId = 'unknown',
      capsuleId = 'unknown',
    } = opts;

    // Step 1: Get tool
    const tool = this._tools.get(toolId);
    if (!tool) {
      throw new Error('unknown tool');
    }

    // Step 2: Permission check
    const permResult = this.checkPermission(toolId, grantedPermissions);
    if (!permResult.allowed) {
      throw new PermissionDeniedError(
        `PermissionDenied: ${permResult.reason} for tool "${toolId}"`
      );
    }

    // Step 3: Approval gate (skip in mock mode)
    if (tool.requiresApproval && executionMode !== 'mock') {
      throw new ApprovalRequiredError(
        `ApprovalRequired: tool "${toolId}" requires explicit approval before execution`
      );
    }

    // Step 4: Call the handler
    const output = await tool.handler({
      input: input || {},
      state: {},
      executionMode,
      signal: AbortSignal.timeout(5000),
    });

    // Step 5: Write receipt for consequential tools
    let receipt = null;
    if (tool.isConsequential && this._journal) {
      receipt = await this._journal.append({
        loopId,
        runId,
        capsuleId,
        action: toolId,
        status: 'success',
        evidence: {
          toolId,
          inputKeys: Object.keys(input || {}),
        },
      });
    }

    return { output, receiptId: receipt ? receipt.receiptId : null };
  }

  /**
   * Unregister a tool by toolId.
   * @param {string} toolId
   */
  unregister(toolId) {
    this._tools.delete(toolId);
  }
}

module.exports = { ToolGateway, ApprovalRequiredError, PermissionDeniedError };
