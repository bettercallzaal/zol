// src/adapters/warper-keeper-adapter.js
// Warper Keeper connector adapter for ZOL
// Phase 7: Add optional Warper Keeper connector with 3 modes (disabled/mock/remote), NO fallback
// HARD privacy guard: never upload private memory, secrets, signer material

const { createWarperKeeperClient } = require('../../vendor/dreamloops/warper-keeper/src/index.js');

const PRIVATE_MEMORY_PATTERNS = [
  /PRIVATE_KEY/i,
  /SECRET_KEY/i,
  /API_KEY/i,
  /sk-[a-zA-Z0-9_-]+/,        // OpenAI/Anthropic keys
  /ghp_[a-zA-Z0-9_-]+/,       // GitHub PAT
  /[0-9a-fA-F]{64}/,          // 64-char hex (eth private key)
  /hidden_reasoning/i,
  /signer_material/i,
  /signing_key/i,
  /private_memory/i,
];

/**
 * Privacy guard: check if content contains patterns that should never be uploaded
 * @param {*} content - content to check
 * @returns {boolean} true if content contains private patterns
 */
function hasPrivatePatterns(content) {
  const str = JSON.stringify(content);
  return PRIVATE_MEMORY_PATTERNS.some(pattern => pattern.test(str));
}

/**
 * Build Warper Keeper adapter client
 * @param {Object} options
 * @param {string} options.mode - 'disabled' (default), 'mock', or 'remote'
 * @param {string} options.baseUrl - remote base URL (required in remote mode)
 * @param {string} options.assignmentKey - assignment key (required in remote/mock assignment ops)
 * @param {number} options.timeoutMs - timeout in ms (default 8000, max 120000)
 * @param {Object} options.mockHandlers - mock handlers (required in mock mode)
 * @param {Function} options.fetch - fetch implementation (required in remote mode)
 * @returns {Object} adapter with all operations
 */
function createWarperKeeperAdapter(options = {}) {
  const mode = options.mode ?? 'disabled';

  // Validate mode early
  if (!['disabled', 'mock', 'remote'].includes(mode)) {
    throw new Error(`[Warper Keeper] Invalid mode: ${mode}. Must be one of: disabled, mock, remote`);
  }

  // Build client options - never pass real assignment key in non-assignment ops
  const clientOptions = {
    mode,
    baseUrl: options.baseUrl || process.env.WARPER_KEEPER_URL,
    assignmentKey: options.assignmentKey || process.env.WARPER_KEEPER_ASSIGNMENT_KEY,
    timeoutMs: options.timeoutMs || 8_000,
    fetch: options.fetch || globalThis.fetch,
    // In mock mode, provide default mock handlers that reject unless overridden
    ...(mode === 'mock' && {
      mock: options.mockHandlers || getDefaultMockHandlers(),
    }),
  };

  // Create the underlying client - this will validate mode/config
  let client;
  try {
    client = createWarperKeeperClient(clientOptions);
  } catch (err) {
    throw new Error(`[Warper Keeper] Failed to create client in ${mode} mode: ${err.message}`);
  }

  /**
   * Discover capabilities from the Warper Keeper
   * Safe read operation - no privacy concerns
   * @param {Object} options
   * @param {string} options.correlationId - optional correlation ID
   * @returns {Promise<Object>} capabilities response
   */
  async function discoverCapabilities(options = {}) {
    if (mode === 'disabled') {
      throw new Error('[Warper Keeper] Disabled mode: discoverCapabilities not available');
    }
    try {
      const response = await client.discoverCapabilities(buildRequestOptions(options));
      return response;
    } catch (err) {
      throw new Error(`[Warper Keeper] discoverCapabilities failed in ${mode} mode: ${err.message}`);
    }
  }

  /**
   * Get the current assignment
   * Safe read operation - requires assignment key but doesn't leak it
   * @param {Object} options
   * @param {string} options.correlationId - optional correlation ID
   * @returns {Promise<Object>} assignment response
   */
  async function getAssignment(options = {}) {
    if (mode === 'disabled') {
      throw new Error('[Warper Keeper] Disabled mode: getAssignment not available');
    }
    try {
      const response = await client.getAssignment(buildRequestOptions(options));
      return response;
    } catch (err) {
      throw new Error(`[Warper Keeper] getAssignment failed in ${mode} mode: ${err.message}`);
    }
  }

  /**
   * Open a trapper (initialize work context)
   * GUARDED: no private data allowed in payload
   * @param {Object} payload
   * @param {Object} options
   * @returns {Promise<Object>} receipt
   */
  async function openTrapper(payload = {}, options = {}) {
    if (mode === 'disabled') {
      throw new Error('[Warper Keeper] Disabled mode: openTrapper not available');
    }
    guardPrivateData('openTrapper', payload);
    try {
      const response = await client.openTrapper(payload, buildRequestOptions(options, true));
      return response;
    } catch (err) {
      throw new Error(`[Warper Keeper] openTrapper failed in ${mode} mode: ${err.message}`);
    }
  }

  /**
   * Append context to the trapper
   * GUARDED: strictly validate context - no hidden reasoning, signer, secrets
   * @param {Object} payload - context payload (kind, text, etc.)
   * @param {Object} options - request options
   * @returns {Promise<Object>} receipt
   */
  async function appendContext(payload = {}, options = {}) {
    if (mode === 'disabled') {
      throw new Error('[Warper Keeper] Disabled mode: appendContext not available');
    }
    guardPrivateData('appendContext', payload);
    if (payload.text && typeof payload.text === 'string') {
      validateContextText(payload.text);
    }
    try {
      const response = await client.appendContext(payload, buildRequestOptions(options, true));
      return response;
    } catch (err) {
      throw new Error(`[Warper Keeper] appendContext failed in ${mode} mode: ${err.message}`);
    }
  }

  /**
   * Submit an artifact reference (not raw content)
   * GUARDED: only URIs and metadata - never raw content
   * @param {Object} payload - artifact metadata (uri, mediaType, etc.)
   * @param {Object} options
   * @returns {Promise<Object>} receipt
   */
  async function submitArtifact(payload = {}, options = {}) {
    if (mode === 'disabled') {
      throw new Error('[Warper Keeper] Disabled mode: submitArtifact not available');
    }
    // Artifact submission should only include references, not raw content
    if (payload.content || payload.body || payload.data) {
      throw new Error('[Warper Keeper] submitArtifact must only include URIs and metadata, not raw content');
    }
    guardPrivateData('submitArtifact', payload);
    try {
      const response = await client.submitArtifact(payload, buildRequestOptions(options, true));
      return response;
    } catch (err) {
      throw new Error(`[Warper Keeper] submitArtifact failed in ${mode} mode: ${err.message}`);
    }
  }

  /**
   * Request approval for an action
   * Safe operation - just requesting approval
   * @param {Object} payload
   * @param {Object} options
   * @returns {Promise<Object>} receipt
   */
  async function requestApproval(payload = {}, options = {}) {
    if (mode === 'disabled') {
      throw new Error('[Warper Keeper] Disabled mode: requestApproval not available');
    }
    guardPrivateData('requestApproval', payload);
    try {
      const response = await client.requestApproval(payload, buildRequestOptions(options, true));
      return response;
    } catch (err) {
      throw new Error(`[Warper Keeper] requestApproval failed in ${mode} mode: ${err.message}`);
    }
  }

  /**
   * Close the trapper (terminal action - work complete)
   * @param {Object} payload
   * @param {Object} options
   * @returns {Promise<Object>} receipt
   */
  async function closeTrapper(payload = {}, options = {}) {
    if (mode === 'disabled') {
      throw new Error('[Warper Keeper] Disabled mode: closeTrapper not available');
    }
    guardPrivateData('closeTrapper', payload);
    try {
      const response = await client.closeTrapper(payload, buildRequestOptions(options, true));
      return response;
    } catch (err) {
      throw new Error(`[Warper Keeper] closeTrapper failed in ${mode} mode: ${err.message}`);
    }
  }

  /**
   * Release assignment (handback without completion)
   * @param {Object} payload
   * @param {Object} options
   * @returns {Promise<Object>} receipt
   */
  async function releaseAssignment(payload = {}, options = {}) {
    if (mode === 'disabled') {
      throw new Error('[Warper Keeper] Disabled mode: releaseAssignment not available');
    }
    guardPrivateData('releaseAssignment', payload);
    try {
      const response = await client.releaseAssignment(payload, buildRequestOptions(options, true));
      return response;
    } catch (err) {
      throw new Error(`[Warper Keeper] releaseAssignment failed in ${mode} mode: ${err.message}`);
    }
  }

  /**
   * Verify proof (check artifact receipt)
   * @param {string} receiptId
   * @param {Object} options
   * @returns {Promise<Object>} verification response
   */
  async function verifyProof(receiptId, options = {}) {
    if (mode === 'disabled') {
      throw new Error('[Warper Keeper] Disabled mode: verifyProof not available');
    }
    try {
      const response = await client.verifyProof(receiptId, buildRequestOptions(options));
      return response;
    } catch (err) {
      throw new Error(`[Warper Keeper] verifyProof failed in ${mode} mode: ${err.message}`);
    }
  }

  return Object.freeze({
    mode,
    isEnabled: () => mode !== 'disabled',
    discoverCapabilities,
    getAssignment,
    openTrapper,
    appendContext,
    submitArtifact,
    requestApproval,
    closeTrapper,
    releaseAssignment,
    verifyProof,
  });
}

/**
 * Guard against private data in payloads
 * Throws if private patterns detected
 */
function guardPrivateData(operationName, payload) {
  if (hasPrivatePatterns(payload)) {
    throw new Error(
      `[Warper Keeper] PRIVACY VIOLATION: ${operationName} payload contains private data patterns (secrets, keys, hidden reasoning, signer material). Refusing to send.`
    );
  }
}

/**
 * Validate context text against private patterns
 */
function validateContextText(text) {
  if (PRIVATE_MEMORY_PATTERNS.some(pattern => pattern.test(text))) {
    throw new Error(
      '[Warper Keeper] PRIVACY VIOLATION: appendContext text contains private data patterns. Only bounded, explicitly-allowed context may be sent.'
    );
  }
}

/**
 * Build request options with idempotency/correlation IDs
 * @param {Object} options
 * @param {boolean} isWrite - whether this is a write operation
 * @returns {Object} normalized request options
 */
function buildRequestOptions(options = {}, isWrite = false) {
  return {
    correlationId: options.correlationId || `zol-${Date.now()}`,
    ...(isWrite && {
      idempotencyKey: options.idempotencyKey || `zol-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    }),
  };
}

/**
 * Default mock handlers - reject all operations
 * (caller can override with their own handlers in mock mode)
 */
function getDefaultMockHandlers() {
  return {
    discoverCapabilities: async () => {
      throw new Error('[Warper Keeper Mock] No mock handler provided for discoverCapabilities');
    },
    getAssignment: async () => {
      throw new Error('[Warper Keeper Mock] No mock handler provided for getAssignment');
    },
    openTrapper: async () => {
      throw new Error('[Warper Keeper Mock] No mock handler provided for openTrapper');
    },
    appendContext: async () => {
      throw new Error('[Warper Keeper Mock] No mock handler provided for appendContext');
    },
    submitArtifact: async () => {
      throw new Error('[Warper Keeper Mock] No mock handler provided for submitArtifact');
    },
    requestApproval: async () => {
      throw new Error('[Warper Keeper Mock] No mock handler provided for requestApproval');
    },
    closeTrapper: async () => {
      throw new Error('[Warper Keeper Mock] No mock handler provided for closeTrapper');
    },
    releaseAssignment: async () => {
      throw new Error('[Warper Keeper Mock] No mock handler provided for releaseAssignment');
    },
    verifyProof: async () => {
      throw new Error('[Warper Keeper Mock] No mock handler provided for verifyProof');
    },
  };
}

module.exports = {
  createWarperKeeperAdapter,
  hasPrivatePatterns,
  PRIVATE_MEMORY_PATTERNS,
};
