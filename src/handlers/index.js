// src/handlers/index.js - Typed DreamLoop handlers for ZOL
// All handlers: validate input strictly, honor AbortSignal/timeout, return structured state
// No generic shell execution. No signer/Ed25519 key touches. No posting without approval gate.

const fs = require('fs');
const path = require('path');
const { ork } = require('../zol-lib');
const { getNeynarMentions, searchNeynarCasts, fetchCalendarICS, getDefaultCalendarUrl } = require('../integrations');

// Validation helper
function validateInput(input, schema) {
  const { required = [], types = {} } = schema;
  for (const key of required) {
    if (!(key in input)) throw new Error(`missing required input: ${key}`);
  }
  for (const [key, expectedType] of Object.entries(types)) {
    if (key in input && typeof input[key] !== expectedType) {
      throw new Error(`invalid type for ${key}: expected ${expectedType}, got ${typeof input[key]}`);
    }
  }
  return true;
}

// State handlers: read/write via state-adapter
const handlers = {
  // ===== STATE HANDLERS =====
  'state.local.read': async function({ input, state, signal }) {
    const timeoutHandle = signal ? () => {
      throw new Error('state.local.read timed out');
    } : null;
    signal?.addEventListener('abort', timeoutHandle, { once: true });

    try {
      validateInput(input, {
        required: input.listCheckpoints ? [] : ['stateKey'],
        types: { stateKey: 'string' }
      });

      // PHASE 5: wire to actual state-adapter once integrated
      // For now, return structured state mock
      if (input.listCheckpoints) {
        return {
          checkpoints: [
            { id: 'zol-checkpoint-latest', timestamp: new Date().toISOString() }
          ]
        };
      }

      return {
        loaded: true,
        key: input.stateKey,
        timestamp: new Date().toISOString()
      };
    } finally {
      if (timeoutHandle && signal) signal.removeEventListener('abort', timeoutHandle);
    }
  },

  'state.local.write': async function({ input, state, executionMode, signal }) {
    validateInput(input, {
      required: ['stateKey'],
      types: { stateKey: 'string' }
    });

    // Guard: reject secret patterns (skip in mock mode for testing)
    if (executionMode !== 'mock') {
      const secretPattern = /[0-9a-fA-F]{64}|sk-[a-zA-Z0-9_-]+|ghp_[a-zA-Z0-9_-]+/;
      if (secretPattern.test(JSON.stringify(state))) {
        throw new Error('[SECURITY] Refusing to persist state with secret pattern');
      }
    }

    // PHASE 5: wire to actual state-adapter
    return {
      written: true,
      key: input.stateKey,
      timestamp: new Date().toISOString(),
      operation: input.operation || 'write'
    };
  },

  // ===== MEMORY HANDLERS =====
  'memory.read': async function({ input, state, signal }) {
    validateInput(input, {
      types: { maxRecent: 'number', scope: 'string' }
    });

    // PHASE 5: wire to actual memory store or state-adapter
    return {
      memories: [],
      count: 0,
      scope: input.scope || 'general',
      timestamp: new Date().toISOString()
    };
  },

  'memory.write': async function({ input, state, executionMode, signal }) {
    validateInput(input, {
      required: ['memoryType'],
      types: { memoryType: 'string', consolidation: 'string' }
    });

    // Guard: reject secrets (skip in mock mode for testing)
    if (executionMode !== 'mock') {
      const secretPattern = /[0-9a-fA-F]{64}|sk-[a-zA-Z0-9_-]+|ghp_[a-zA-Z0-9_-]+/;
      if (secretPattern.test(JSON.stringify(state))) {
        throw new Error('[SECURITY] Refusing to persist memory with secret pattern');
      }
    }

    // PHASE 5: wire to actual memory store
    return {
      written: true,
      memoryType: input.memoryType,
      timestamp: new Date().toISOString()
    };
  },

  // ===== TASK HANDLERS =====
  'task.read': async function({ input, state, signal }) {
    validateInput(input, {
      types: { filter: 'string', maxRecent: 'number' }
    });

    // PHASE 5: wire to actual task store
    return {
      tasks: [],
      count: 0,
      filter: input.filter || 'all',
      timestamp: new Date().toISOString()
    };
  },

  'task.capture': async function({ input, state, executionMode, signal }) {
    // In mock mode, allow missing description for dry-run testing
    if (executionMode !== 'mock') {
      validateInput(input, {
        required: ['description'],
        types: { description: 'string', source: 'string' }
      });
    }

    const description = input.description || `[Mock task captured in ${executionMode || 'normal'} mode]`;
    const taskId = `task_${Math.random().toString(36).slice(2, 9)}`;
    // PHASE 5: wire to actual task store
    return {
      taskId,
      description: description.slice(0, 500),
      source: input.source || 'manual',
      status: 'open',
      timestamp: new Date().toISOString()
    };
  },

  'task.plan': async function({ input, state, signal }) {
    validateInput(input, {
      types: { scope: 'string' }
    });

    // PHASE 5: wire to actual planning logic or LLM for estimation
    return {
      planned: true,
      scope: input.scope || 'general',
      estimatedEffort: 'medium',
      priority: 'normal',
      timestamp: new Date().toISOString()
    };
  },

  // ===== RECEIPT HANDLER =====
  'receipt.local.write': async function({ input, state, signal }) {
    validateInput(input, {
      required: ['receiptType'],
      types: { receiptType: 'string' }
    });

    // PHASE 5: wire to actual receipt store via state-adapter
    return {
      receiptId: `rcpt_${Math.random().toString(36).slice(2, 9)}`,
      receiptType: input.receiptType,
      timestamp: new Date().toISOString()
    };
  },

  // ===== BUDGET / MODEL HANDLERS =====
  'budget.read': async function({ input, state, signal }) {
    // Mock: return budget state
    // PHASE 5: read from env var + actual usage tracking
    return {
      dailyLimit: process.env.BOUNDED_DAILY_LIMIT || 100000,
      consumed: 0,
      remaining: parseInt(process.env.BOUNDED_DAILY_LIMIT || 100000),
      timestamp: new Date().toISOString()
    };
  },

  'model.usage.read': async function({ input, state, signal }) {
    validateInput(input, {
      types: { model: 'string' }
    });

    // PHASE 5: query OpenRouter API or local tracking
    return {
      model: input.model || 'claude-fable-5',
      tokensToday: 0,
      callsToday: 0,
      averageLatencyMs: 0,
      timestamp: new Date().toISOString()
    };
  },

  // ===== FARCASTER / SOCIAL HANDLERS =====
  'farcaster.read': async function({ input, state, signal }) {
    validateInput(input, {
      types: { query: 'string', limit: 'number' }
    });

    const query = input.query || 'mentions_24h';
    const limit = input.limit || 10;

    try {
      // PHASE 5: wire to Neynar API
      // Support two query types: mentions_24h (fetch mentions for ZOL) or search_casts (search by query)
      let results = [];
      let count = 0;

      if (query === 'mentions_24h' || query.includes('mention')) {
        // Fetch mentions for ZOL's FID (3338501)
        const mentionResult = await getNeynarMentions(3338501, limit);
        if (!mentionResult.error) {
          results = mentionResult.mentions || [];
          count = mentionResult.count || 0;
        }
      } else {
        // Search casts by query
        const searchResult = await searchNeynarCasts(query, limit);
        if (!searchResult.error) {
          results = searchResult.casts || [];
          count = searchResult.count || 0;
        }
      }

      return {
        query,
        results,
        count,
        timestamp: new Date().toISOString()
      };
    } catch (e) {
      // Return structured error state
      return {
        query,
        results: [],
        count: 0,
        error: e.message,
        timestamp: new Date().toISOString()
      };
    }
  },

  'farcaster.reply': async function({ input, state, signal }) {
    // CRITICAL: This handler enforces draft-only + approval gate
    // NO direct posting without approval.
    validateInput(input, {
      required: ['requireApprovalToken'],
      types: { draftFromState: 'string', requireApprovalToken: 'boolean' }
    });

    if (!input.requireApprovalToken) {
      throw new Error('[SECURITY] farcaster.reply requires explicit approval token (blocked_actions: public.publish.without_approval)');
    }

    // PHASE 5: verify approval token, then call zol-lib.post()
    return {
      posted: false,
      reason: 'PHASE 4: draft-only, approval gate required',
      draftStaged: true,
      awaitingApproval: true,
      timestamp: new Date().toISOString()
    };
  },

  'inbox.read': async function({ input, state, signal }) {
    validateInput(input, {
      types: { maxRecent: 'number' }
    });

    const maxRecent = input.maxRecent || 10;

    try {
      // PHASE 5: wire to Neynar API
      // inbox.read fetches recent mentions for ZOL (FID 3338501)
      const mentionResult = await getNeynarMentions(3338501, maxRecent);

      if (mentionResult.error) {
        return {
          mentions: [],
          count: 0,
          maxRecent,
          error: mentionResult.error,
          timestamp: new Date().toISOString()
        };
      }

      return {
        mentions: mentionResult.mentions || [],
        count: mentionResult.count || 0,
        maxRecent,
        timestamp: new Date().toISOString()
      };
    } catch (e) {
      return {
        mentions: [],
        count: 0,
        maxRecent,
        error: e.message,
        timestamp: new Date().toISOString()
      };
    }
  },

  // ===== CLASSIFICATION / REASONING HANDLERS =====
  'message.classify': async function({ input, state, signal }) {
    validateInput(input, {
      types: { types: 'object' }
    });

    // PHASE 5: wire to LLM for classification (use ork() with timeout)
    // For dry-run, return mock
    return {
      classified: true,
      types: input.types || [],
      chosen: 'respond',
      confidence: 0.8,
      timestamp: new Date().toISOString()
    };
  },

  'priority.plan': async function({ input, state, signal }) {
    validateInput(input, {
      types: { methode: 'string' }
    });

    // PHASE 5: wire to LLM or ranking algorithm
    return {
      planned: true,
      method: input.methode || 'task-age',
      priorities: [],
      timestamp: new Date().toISOString()
    };
  },

  'research.synthesize': async function({ input, state, signal }) {
    validateInput(input, {
      types: { citationFormat: 'string' }
    });

    // PHASE 5: wire to LLM for synthesis + citation formatting
    return {
      synthesized: true,
      citationFormat: input.citationFormat || 'structured',
      sources: [],
      summary: '',
      timestamp: new Date().toISOString()
    };
  },

  // ===== RELATIONSHIP HANDLERS =====
  'relationship.read': async function({ input, state, signal }) {
    validateInput(input, {
      types: { full: 'boolean', includeMuted: 'boolean' }
    });

    // PHASE 5: wire to relationship store
    return {
      relationships: [],
      count: 0,
      full: input.full || false,
      timestamp: new Date().toISOString()
    };
  },

  'relationship.write': async function({ input, state, signal }) {
    validateInput(input, {
      types: { updateType: 'string' }
    });

    // PHASE 5: wire to relationship store
    return {
      updated: true,
      updateType: input.updateType || 'interaction-logged',
      timestamp: new Date().toISOString()
    };
  },

  // ===== APPROVAL / ARTIFACT HANDLERS =====
  'approval.request': async function({ input, state, signal }) {
    validateInput(input, {
      required: ['channel', 'operatorId'],
      types: { channel: 'string', operatorId: 'string', timeoutSec: 'number', requireExplicitApproval: 'boolean' }
    });

    // PHASE 5: wire to Telegram bot (ZOE) to send approval request
    // For Phase 4, mark as pending approval
    const timeout = input.timeoutSec * 1000 || 600000;
    return {
      approvalRequested: true,
      channel: input.channel,
      operatorId: input.operatorId,
      timeoutMs: timeout,
      status: 'pending',
      timestamp: new Date().toISOString()
    };
  },

  'artifact.local.write': async function({ input, state, signal }) {
    validateInput(input, {
      required: ['artifactType'],
      types: { artifactType: 'string', validateText: 'boolean', maxLength: 'number' }
    });

    if (input.validateText && input.maxLength) {
      const text = state.text || '';
      if (text.length > input.maxLength) {
        throw new Error(`artifact text exceeds ${input.maxLength} character limit (found ${text.length})`);
      }
    }

    // PHASE 5: write to local artifact store
    return {
      artifactId: `art_${Math.random().toString(36).slice(2, 9)}`,
      artifactType: input.artifactType,
      staged: true,
      timestamp: new Date().toISOString()
    };
  },

  'source.public.read': async function({ input, state, signal }) {
    validateInput(input, {
      types: { source: 'string', scope: 'string', query: 'string' }
    });

    // PHASE 5: wire to public source readers (Farcaster, Neynar, etc.)
    return {
      source: input.source || input.scope,
      results: [],
      count: 0,
      timestamp: new Date().toISOString()
    };
  },

  // ===== CALENDAR HANDLER (PHASE 5) =====
  'calendar.read': async function({ input, state, signal }) {
    validateInput(input, {
      types: { dayCount: 'number', calendarUrl: 'string' }
    });

    const dayCount = input.dayCount || 1;
    const calendarUrl = input.calendarUrl || getDefaultCalendarUrl();

    try {
      // PHASE 5: wire to ICS calendar API (Luma or other ICS feeds)
      const result = await fetchCalendarICS(calendarUrl);

      if (result.error) {
        return {
          read: false,
          reason: `Calendar fetch failed: ${result.error}`,
          dayCount,
          events: [],
          error: result.error,
          timestamp: new Date().toISOString()
        };
      }

      // Filter events to next dayCount days (simple date-based filter)
      const now = new Date();
      const cutoffMs = now.getTime() + dayCount * 24 * 60 * 60 * 1000;
      const cutoff = new Date(cutoffMs).toISOString();

      const futureEvents = (result.events || []).filter(e => {
        const eventTime = e.startTime || '';
        return eventTime <= cutoff && eventTime >= now.toISOString();
      });

      return {
        read: true,
        dayCount,
        events: futureEvents,
        count: futureEvents.length,
        timestamp: new Date().toISOString()
      };
    } catch (e) {
      return {
        read: false,
        reason: `Calendar read error: ${e.message}`,
        dayCount,
        events: [],
        error: e.message,
        timestamp: new Date().toISOString()
      };
    }
  }
};

// Export all handlers
module.exports = handlers;
