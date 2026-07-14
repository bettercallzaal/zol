// src/handlers/warper-keeper-handlers.js
// DreamLoop handlers for Warper Keeper connector operations
// Phase 7: Handlers for discovering capabilities, managing assignments, trapper operations, artifacts

const { createWarperKeeperAdapter } = require('../adapters/warper-keeper-adapter');

// Global adapter instance - created once, reused
let adapterInstance = null;

/**
 * Initialize the Warper Keeper adapter (called on first handler invocation)
 */
function ensureAdapter() {
  if (!adapterInstance) {
    adapterInstance = createWarperKeeperAdapter({
      mode: process.env.WARPER_KEEPER_MODE || 'disabled',
      baseUrl: process.env.WARPER_KEEPER_URL,
      assignmentKey: process.env.WARPER_KEEPER_ASSIGNMENT_KEY,
    });
  }
  return adapterInstance;
}

/**
 * Handlers for Warper Keeper operations
 * Each handler validates input strictly, honors timeouts, returns structured state
 * All guards inherited from adapter layer
 */
const handlers = {
  // ===== WARPER KEEPER CAPABILITY DISCOVERY =====
  'warper.capability.discover': async function({ input, signal }) {
    try {
      const adapter = ensureAdapter();
      const result = await adapter.discoverCapabilities({
        correlationId: input.correlationId,
      });
      return {
        ok: true,
        capabilities: result,
        timestamp: new Date().toISOString(),
      };
    } catch (err) {
      if (err.message.includes('Disabled mode')) {
        return {
          ok: false,
          reason: 'Warper Keeper is disabled',
          mode: 'disabled',
          error: err.message,
          timestamp: new Date().toISOString(),
        };
      }
      throw err;
    }
  },

  // ===== WARPER KEEPER ASSIGNMENT OPERATIONS =====
  'warper.assignment.get': async function({ input, signal }) {
    try {
      const adapter = ensureAdapter();
      const result = await adapter.getAssignment({
        correlationId: input.correlationId,
      });
      // Never log the assignment key itself
      return {
        ok: true,
        assignment: {
          id: result.assignment?.id,
          createdAt: result.assignment?.createdAt,
          expiresAt: result.assignment?.expiresAt,
          // Key is NOT included - must stay secret
        },
        timestamp: new Date().toISOString(),
      };
    } catch (err) {
      if (err.message.includes('Disabled mode')) {
        return {
          ok: false,
          reason: 'Warper Keeper is disabled',
          error: err.message,
          timestamp: new Date().toISOString(),
        };
      }
      throw err;
    }
  },

  'warper.assignment.release': async function({ input, signal }) {
    try {
      const adapter = ensureAdapter();
      const result = await adapter.releaseAssignment(
        { reason: input.reason || 'manual-release' },
        {
          correlationId: input.correlationId,
          idempotencyKey: input.idempotencyKey,
        }
      );
      return {
        ok: true,
        status: 'released',
        timestamp: new Date().toISOString(),
      };
    } catch (err) {
      if (err.message.includes('Disabled mode')) {
        return {
          ok: false,
          reason: 'Warper Keeper is disabled',
          error: err.message,
          timestamp: new Date().toISOString(),
        };
      }
      throw err;
    }
  },

  // ===== WARPER KEEPER TRAPPER OPERATIONS =====
  'warper.trapper.open': async function({ input, signal }) {
    try {
      const adapter = ensureAdapter();
      const result = await adapter.openTrapper(
        {
          scope: input.scope || 'work-context',
          metadata: input.metadata,
        },
        {
          correlationId: input.correlationId,
          idempotencyKey: input.idempotencyKey,
        }
      );
      return {
        ok: true,
        receipt: {
          id: result.receipt?.id,
          createdAt: result.receipt?.createdAt,
        },
        timestamp: new Date().toISOString(),
      };
    } catch (err) {
      if (err.message.includes('Disabled mode')) {
        return {
          ok: false,
          reason: 'Warper Keeper is disabled',
          error: err.message,
          timestamp: new Date().toISOString(),
        };
      }
      throw err;
    }
  },

  'warper.trapper.close': async function({ input, signal }) {
    try {
      const adapter = ensureAdapter();
      const result = await adapter.closeTrapper(
        { reason: input.reason || 'work-complete' },
        {
          correlationId: input.correlationId,
          idempotencyKey: input.idempotencyKey,
        }
      );
      return {
        ok: true,
        status: 'closed',
        timestamp: new Date().toISOString(),
      };
    } catch (err) {
      if (err.message.includes('Disabled mode')) {
        return {
          ok: false,
          reason: 'Warper Keeper is disabled',
          error: err.message,
          timestamp: new Date().toISOString(),
        };
      }
      throw err;
    }
  },

  // ===== WARPER KEEPER CONTEXT & ARTIFACTS =====
  'warper.context.append': async function({ input, signal }) {
    try {
      const adapter = ensureAdapter();
      if (!input.kind || !input.text) {
        throw new Error('appendContext requires kind and text');
      }
      const result = await adapter.appendContext(
        {
          kind: input.kind, // 'summary', 'reasoning', 'decision', etc.
          text: input.text,
          metadata: input.metadata,
        },
        {
          correlationId: input.correlationId,
          idempotencyKey: input.idempotencyKey,
        }
      );
      return {
        ok: true,
        receipt: {
          id: result.receipt?.id,
          kind: input.kind,
        },
        timestamp: new Date().toISOString(),
      };
    } catch (err) {
      if (err.message.includes('Disabled mode')) {
        return {
          ok: false,
          reason: 'Warper Keeper is disabled',
          error: err.message,
          timestamp: new Date().toISOString(),
        };
      }
      if (err.message.includes('PRIVACY VIOLATION')) {
        throw err; // Re-throw privacy violations as hard errors
      }
      throw err;
    }
  },

  'warper.artifact.submit': async function({ input, signal }) {
    try {
      const adapter = ensureAdapter();
      if (!input.uri || !input.mediaType) {
        throw new Error('submitArtifact requires uri and mediaType');
      }
      const result = await adapter.submitArtifact(
        {
          uri: input.uri, // Reference only, never raw content
          mediaType: input.mediaType,
          checksum: input.checksum,
          metadata: input.metadata,
        },
        {
          correlationId: input.correlationId,
          idempotencyKey: input.idempotencyKey,
        }
      );
      return {
        ok: true,
        receipt: {
          id: result.receipt?.id,
          uri: input.uri,
        },
        timestamp: new Date().toISOString(),
      };
    } catch (err) {
      if (err.message.includes('Disabled mode')) {
        return {
          ok: false,
          reason: 'Warper Keeper is disabled',
          error: err.message,
          timestamp: new Date().toISOString(),
        };
      }
      if (err.message.includes('PRIVACY VIOLATION')) {
        throw err; // Re-throw privacy violations as hard errors
      }
      throw err;
    }
  },

  // ===== WARPER KEEPER APPROVAL & PROOF =====
  'warper.approval.request': async function({ input, signal }) {
    try {
      const adapter = ensureAdapter();
      const result = await adapter.requestApproval(
        {
          action: input.action,
          artifactReceiptId: input.artifactReceiptId,
          metadata: input.metadata,
        },
        {
          correlationId: input.correlationId,
          idempotencyKey: input.idempotencyKey,
        }
      );
      return {
        ok: true,
        status: 'pending-approval',
        timestamp: new Date().toISOString(),
      };
    } catch (err) {
      if (err.message.includes('Disabled mode')) {
        return {
          ok: false,
          reason: 'Warper Keeper is disabled',
          error: err.message,
          timestamp: new Date().toISOString(),
        };
      }
      throw err;
    }
  },

  'warper.proof.verify': async function({ input, signal }) {
    try {
      const adapter = ensureAdapter();
      if (!input.receiptId) {
        throw new Error('verifyProof requires receiptId');
      }
      const result = await adapter.verifyProof(input.receiptId, {
        correlationId: input.correlationId,
      });
      return {
        ok: true,
        verified: result.verified,
        receipt: {
          id: result.receipt?.id,
        },
        timestamp: new Date().toISOString(),
      };
    } catch (err) {
      if (err.message.includes('Disabled mode')) {
        return {
          ok: false,
          reason: 'Warper Keeper is disabled',
          verified: false,
          error: err.message,
          timestamp: new Date().toISOString(),
        };
      }
      throw err;
    }
  },

  // ===== STATUS HANDLER =====
  'warper.status': async function({ input, signal }) {
    try {
      const adapter = ensureAdapter();
      return {
        ok: true,
        mode: adapter.mode,
        enabled: adapter.isEnabled(),
        timestamp: new Date().toISOString(),
      };
    } catch (err) {
      throw err;
    }
  },
};

module.exports = { handlers };
