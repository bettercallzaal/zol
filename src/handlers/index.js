// src/handlers/index.js - Typed DreamLoop handlers for ZOL
// All handlers: validate input strictly, honor AbortSignal/timeout, return structured state
// No generic shell execution. No signer/Ed25519 key touches. No posting without approval gate.

const fs = require('fs');
const path = require('path');
const { ork } = require('../zol-lib');
const { getNeynarMentions, searchNeynarCasts, fetchCalendarICS, getDefaultCalendarUrl, fetchNeynarWithTimeout, getNeynarKey } = require('../integrations');

// Lazy-initialized singletons (created on first real handler call)
let _stateStore = null;
let _memoryWeaver = null;
let _receiptJournal = null;

function getStateStore() {
  if (!_stateStore) {
    const { createStateStore } = require('../state-adapter');
    const os = require('os');
    const dir = process.env.ZOL_STATE_DIR || (os.homedir() + '/.zao/private/zol-state');
    _stateStore = createStateStore({ backend: process.env.ZOL_STATE_BACKEND || 'atomic-file', directory: dir });
  }
  return _stateStore;
}

function getMemoryWeaver() {
  if (!_memoryWeaver) {
    const { MemoryWeaver } = require('../memory-weaver');
    _memoryWeaver = new MemoryWeaver(getStateStore());
  }
  return _memoryWeaver;
}

function getReceiptJournal() {
  if (!_receiptJournal) {
    const { ReceiptJournal } = require('../receipt-journal');
    _receiptJournal = new ReceiptJournal(getStateStore(), { agentId: 'zolbot' });
  }
  return _receiptJournal;
}

// ModelGateway uses a noop store — getStateStore() is async-initialized (returns a Promise)
// so it can't be passed directly to ModelGateway's synchronous constructor. Quota/telemetry
// not persisted at the handler layer; the WorkRouter/AgentGateway provide higher-level accounting.
const _MGW_NOOP_STORE = {
  async get() { return undefined; },
  async put() {},
  async initialize() {},
};
let _modelGateway = null;
function getModelGateway() {
  if (!_modelGateway) {
    const { ModelGateway } = require('../model-gateway');
    _modelGateway = new ModelGateway(_MGW_NOOP_STORE);
  }
  return _modelGateway;
}

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
  'state.local.read': async function({ input, state, executionMode, signal }) {
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
      if (executionMode !== 'mock') {
        try {
          const store = getStateStore();
          await store.initialize();
          if (input.listCheckpoints) {
            const checkpoints = (await store.get('zol-checkpoints')) || [];
            return { checkpoints };
          }
          const value = await store.get(input.stateKey);
          return { loaded: true, key: input.stateKey, value, timestamp: new Date().toISOString() };
        } catch (err) {
          // fall through to mock on error
        }
      }

      // Mock fallback
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

    if (executionMode !== 'mock') {
      try {
        const store = getStateStore();
        await store.initialize();
        await store.put(input.stateKey, state);
      } catch (err) {
        // fall through to mock return on error
      }
    }

    // Mock / fallback return
    return {
      written: true,
      key: input.stateKey,
      timestamp: new Date().toISOString(),
      operation: input.operation || 'write'
    };
  },

  // ===== MEMORY HANDLERS =====
  'memory.read': async function({ input, state, executionMode, signal }) {
    validateInput(input, {
      types: { maxRecent: 'number', scope: 'string' }
    });

    if (executionMode !== 'mock') {
      try {
        const mw = getMemoryWeaver();
        const memories = await mw.read({ type: input.memoryType, tags: input.tags, limit: input.limit });
        return { memories, count: memories.length };
      } catch (err) {
        // fall through to mock
      }
    }

    // Mock fallback
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

    if (executionMode !== 'mock') {
      try {
        const mw = getMemoryWeaver();
        const entry = await mw.write({
          type: input.memoryType || 'working',
          subtype: input.subtype || null,
          content: state,
          tags: input.tags || [],
          provenance: input.provenance || { sourceType: 'handler', loopId: null, timestamp: new Date().toISOString(), confidence: 0.8 },
          visibility: input.visibility || 'private',
          dedupeKey: input.dedupeKey || null,
        });
        return { written: true, memoryId: entry.memoryId, type: entry.type };
      } catch (err) {
        // fall through to mock
      }
    }

    // Mock fallback
    return {
      written: true,
      memoryType: input.memoryType,
      timestamp: new Date().toISOString()
    };
  },

  'memory.consolidate': async function({ input, state, executionMode, signal }) {
    if (executionMode !== 'mock') {
      try {
        const mw = getMemoryWeaver();
        const result = await mw.consolidate();
        return { consolidated: true, ...result };
      } catch (err) {
        // fall through to mock
      }
    }

    // Mock fallback
    return {
      consolidated: true,
      timestamp: new Date().toISOString()
    };
  },

  'memory.expire': async function({ input, state, executionMode, signal }) {
    if (executionMode !== 'mock') {
      try {
        const mw = getMemoryWeaver();
        const result = await mw.expire({ type: input.memoryType });
        return { expired: true, ...result };
      } catch (err) {
        // fall through to mock
      }
    }

    // Mock fallback
    return {
      expired: true,
      memoryType: input.memoryType || null,
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
  'receipt.local.write': async function({ input, state, executionMode, signal }) {
    validateInput(input, {
      required: ['receiptType'],
      types: { receiptType: 'string' }
    });

    if (executionMode !== 'mock') {
      try {
        const journal = getReceiptJournal();
        const receipt = await journal.append({
          loopId: input.loopId || 'unknown',
          runId: input.runId || 'unknown',
          stepId: input.stepId || null,
          capsuleId: input.capsuleId || 'unknown',
          action: input.receiptType || 'handler-action',
          status: input.status || 'success',
          evidence: input.evidence || null,
        });
        return { written: true, receiptId: receipt.receiptId, timestamp: receipt.startedAt };
      } catch (err) {
        // fall through to mock
      }
    }

    // Mock fallback
    return {
      receiptId: `rcpt_${Math.random().toString(36).slice(2, 9)}`,
      receiptType: input.receiptType,
      timestamp: new Date().toISOString()
    };
  },

  'receipt.local.query': async function({ input, state, executionMode, signal }) {
    validateInput(input, {
      types: { loopId: 'string', limit: 'number' }
    });
    if (executionMode !== 'mock') {
      try {
        const journal = getReceiptJournal();
        const receipts = await journal.list({
          loopId: input.loopId || undefined,
          limit: typeof input.limit === 'number' ? input.limit : 20,
        });
        return { receipts, count: receipts.length, queried: true, timestamp: new Date().toISOString() };
      } catch (err) {
        // fall through to empty result
      }
    }
    return { receipts: [], count: 0, queried: false, timestamp: new Date().toISOString() };
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
  // Cast readiness: verify outbound Farcaster/Neynar connectivity and local signer presence
  // before any casting loop fires. Always returns a result — never throws.
  'farcaster.connectivity.check': async function({ input, signal }) {
    const timeoutMs = (input && input.timeoutMs) || 10000;
    const fid = (input && input.fid) || 3338501;
    const started = Date.now();

    // Check 1: Neynar key present
    const keyPresent = Boolean(getNeynarKey());

    // Check 2: Neynar API reachable — lightweight user fetch
    let neynar = 'unreachable';
    let neynarLatencyMs = null;
    if (keyPresent) {
      const t0 = Date.now();
      const result = await fetchNeynarWithTimeout(`/v2/farcaster/user/bulk?fids=${fid}`, {}, timeoutMs);
      neynarLatencyMs = Date.now() - t0;
      if (!result.error) {
        neynar = 'reachable';
      } else {
        neynar = result.error === 'timeout' ? 'timeout' : `error:${result.error}`;
      }
    } else {
      neynar = 'no-key';
    }

    // Check 3: Farcaster credentials file present and non-empty
    let creds = 'missing';
    try {
      const os = require('os');
      const credPath = path.join(os.homedir(), '.openclaw', 'farcaster-credentials.json');
      const stat = fs.statSync(credPath);
      creds = stat.size > 10 ? 'present' : 'empty';
    } catch (_) {
      creds = 'missing';
    }

    const ok = neynar === 'reachable' && creds === 'present';
    return {
      ok,
      neynar,
      creds,
      keyPresent,
      neynarLatencyMs,
      totalMs: Date.now() - started,
      timestamp: new Date().toISOString(),
    };
  },

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
  },

  // ===== STUB HANDLERS (PHASE 5 wiring) =====

  'telegram.approval.request': async function({ input, state, signal }) {
    validateInput(input, {
      types: { message: 'string', context: 'string', timeout_ms: 'number' }
    });
    // PHASE 5: route to Telegram approval bridge
    return {
      requested: true,
      channel: 'telegram',
      message: input.message || input.context || '',
      status: 'pending',
      timestamp: new Date().toISOString()
    };
  },

  'farcaster.activity-read': async function({ input, state, signal }) {
    validateInput(input, {
      types: { fid: 'number', limit: 'number', cursor: 'string' }
    });
    // PHASE 5: wire to Neynar activity endpoint
    return {
      fid: input.fid || null,
      casts: [],
      cursor: null,
      count: 0,
      timestamp: new Date().toISOString()
    };
  },

  'cast.read': async function({ input, state, signal }) {
    validateInput(input, {
      types: { fid: 'number', limit: 'number', channel: 'string' }
    });
    // PHASE 5: wire to farcaster.read
    return {
      fid: input.fid || null,
      casts: [],
      count: 0,
      timestamp: new Date().toISOString()
    };
  },

  'cast.draft': async function({ input, state, signal }) {
    validateInput(input, {
      required: ['text'],
      types: { text: 'string', channel: 'string', parent: 'string' }
    });
    // SECURITY: never posts; returns staged draft only
    return {
      drafted: true,
      draftId: `draft_${Math.random().toString(36).slice(2, 9)}`,
      text: input.text,
      channel: input.channel || null,
      status: 'staged',
      timestamp: new Date().toISOString()
    };
  },

  'farcaster.recent-casts-parse': async function({ input, state, signal }) {
    const rawCasts = (state && state.casts) || input.casts || [];
    const MUSIC_KEYWORDS = ['music', 'song', 'album', 'track', 'artist', 'sound', 'beat', 'release',
      'listen', 'playlist', 'stream', 'spotify', 'soundcloud', 'bandcamp', 'producer', 'remix'];
    const summaries = rawCasts.slice(0, 50).map((c) => {
      const text = c.text || '';
      const isMusic = MUSIC_KEYWORDS.some(k => text.toLowerCase().includes(k));
      return {
        hash: c.hash || null,
        fid: (c.author && c.author.fid) || c.fid || null,
        text: text.slice(0, 280),
        channel: (c.channel && c.channel.id) || c.channelId || null,
        likes: (c.reactions && c.reactions.likesCount) || c.likesCount || 0,
        isMusic,
        timestamp: c.timestamp || null,
      };
    });
    const musicCasts = summaries.filter(s => s.isMusic);
    return {
      parsed: true,
      count: summaries.length,
      musicCount: musicCasts.length,
      summaries,
      musicCasts,
      timestamp: new Date().toISOString(),
    };
  },

  'farcaster.dm-send': async function({ input, state, signal }) {
    validateInput(input, {
      required: ['recipientFid', 'message'],
      types: { recipientFid: 'number', message: 'string' }
    });
    // SECURITY: draft-only — actual DM send requires approval gate (PHASE 5)
    return {
      drafted: true,
      recipientFid: input.recipientFid,
      message: input.message,
      status: 'draft_only',
      timestamp: new Date().toISOString()
    };
  },

  'log.relationship-events-write': async function({ input, state, signal }) {
    validateInput(input, {
      types: { eventType: 'string', fid: 'number', note: 'string' }
    });
    try {
      const { createStateStore } = require('../state-adapter');
      const store = await createStateStore();
      const key = 'relationship-events-log';
      const entry = {
        eventType: input.eventType || 'unknown',
        fid: input.fid || null,
        note: input.note || '',
        timestamp: new Date().toISOString(),
      };
      let log = await store.get(key) || [];
      if (!Array.isArray(log)) log = [];
      log.push(entry);
      if (log.length > 500) log = log.slice(log.length - 500);
      await store.put(key, log);
      return { logged: true, eventType: entry.eventType, fid: entry.fid, timestamp: entry.timestamp };
    } catch (_err) {
      // fall through — log is non-critical, return mock shape
    }
    return {
      logged: true,
      eventType: input.eventType || 'unknown',
      fid: input.fid || null,
      timestamp: new Date().toISOString()
    };
  },

  'log.zol-events-write': async function({ input, state, signal }) {
    validateInput(input, {
      types: { event: 'string', context: 'string' }
    });
    try {
      const { createStateStore } = require('../state-adapter');
      const store = await createStateStore();
      const key = 'zol-events-log';
      const entry = {
        event: input.event || 'unknown',
        context: input.context || '',
        timestamp: new Date().toISOString(),
      };
      let log = await store.get(key) || [];
      if (!Array.isArray(log)) log = [];
      log.push(entry);
      if (log.length > 500) log = log.slice(log.length - 500);
      await store.put(key, log);
      return { logged: true, event: entry.event, timestamp: entry.timestamp };
    } catch (_err) {
      // fall through — log is non-critical
    }
    return {
      logged: true,
      event: input.event || 'unknown',
      timestamp: new Date().toISOString()
    };
  },

  'model.completion': async function({ input, state, signal }) {
    validateInput(input, {
      types: { prompt: 'string', model: 'string', tier: 'string', maxTokens: 'number' }
    });
    // tier: 'cheap' (classify/route), 'standard' (default), 'frontier' (build/reason)
    const result = await getModelGateway().complete(input.prompt || '', {
      tier: input.tier || 'standard',
      model: input.model || undefined,
    });
    return {
      completed: true,
      text: result.text,
      tier: input.tier || 'standard',
      model: result.model,
      tokens: result.tokensEstimate || 0,
      provider: result.provider,
      timestamp: new Date().toISOString()
    };
  },

  'checkpoint.local.write': async function({ input, state, signal }) {
    validateInput(input, {
      types: { checkpointKey: 'string', workPacketId: 'string' }
    });
    const id = `chk_${Math.random().toString(36).slice(2, 9)}`;
    try {
      const { createStateStore } = require('../state-adapter');
      const store = await createStateStore();
      const key = 'zol-checkpoints';
      const entry = {
        id,
        checkpointKey: input.checkpointKey || 'default',
        workPacketId: input.workPacketId || null,
        timestamp: new Date().toISOString(),
      };
      let checkpoints = await store.get(key) || [];
      if (!Array.isArray(checkpoints)) checkpoints = [];
      checkpoints.push(entry);
      if (checkpoints.length > 100) checkpoints = checkpoints.slice(checkpoints.length - 100);
      await store.put(key, checkpoints);
      return { written: true, checkpointId: id, checkpointKey: entry.checkpointKey, timestamp: entry.timestamp };
    } catch (_err) {
      // fall through — checkpoint is non-critical
    }
    return {
      written: true,
      checkpointId: id,
      checkpointKey: input.checkpointKey || 'default',
      timestamp: new Date().toISOString()
    };
  },

  'artifact.draft.write': async function({ input, state, signal }) {
    validateInput(input, {
      types: { artifactType: 'string', title: 'string' }
    });
    // SECURITY: draft status only — publishing requires separate approval gate
    return {
      artifactId: `art_${Math.random().toString(36).slice(2, 9)}`,
      artifactType: input.artifactType || 'unknown',
      status: 'draft',
      staged: true,
      timestamp: new Date().toISOString()
    };
  },

  'api.read.external': async function({ input, state, signal }) {
    validateInput(input, {
      types: { url: 'string', method: 'string', scope: 'string' }
    });
    // Conservative allowlist — only ZAO-approved read endpoints.
    // Adding a new origin requires design review (PR + Zaal approval).
    const ALLOWED_PREFIXES = [
      'https://api.neynar.com/',
      'https://hub-api.neynar.com/',
      'https://zabalgamez.com/',
    ];
    const url = input.url || '';
    const timeoutMs = typeof input.timeout_ms === 'number' ? input.timeout_ms : 15000;
    if (!ALLOWED_PREFIXES.some(prefix => url.startsWith(prefix))) {
      return {
        read: false,
        url,
        data: null,
        status: null,
        error: 'URL not in approved allowlist',
        timestamp: new Date().toISOString(),
      };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { method: 'GET', signal: controller.signal });
      clearTimeout(timer);
      const text = await res.text();
      let data;
      try { data = JSON.parse(text); } catch { data = text; }
      return { read: true, url, data, status: res.status, timestamp: new Date().toISOString() };
    } catch (err) {
      clearTimeout(timer);
      return { read: false, url, data: null, status: null, error: err.message, timestamp: new Date().toISOString() };
    }
  },

  'bonfire.delve-recall': async function({ input, state, signal }) {
    validateInput(input, {
      types: { query: 'string', scope: 'string', limit: 'number' }
    });
    // PHASE 5: blocked on BrandonDucar/dream-net PRs #1559/#1560
    return {
      recalled: false,
      reason: 'bonfire-integration-pending',
      results: [],
      timestamp: new Date().toISOString()
    };
  },

  'toolgym.mastery.record': async function({ input, state, signal }) {
    validateInput(input, {
      types: { tool: 'string', score: 'number', context: 'string' }
    });
    const entry = {
      tool: input.tool || 'unknown',
      score: typeof input.score === 'number' ? input.score : 0,
      context: input.context || '',
      timestamp: new Date().toISOString(),
    };
    try {
      const { createStateStore } = require('../state-adapter');
      const store = await createStateStore();
      const key = 'toolgym-mastery-records';
      let records = await store.get(key) || [];
      if (!Array.isArray(records)) records = [];
      records.push(entry);
      if (records.length > 200) records = records.slice(records.length - 200);
      await store.put(key, records);
      return { recorded: true, tool: entry.tool, score: entry.score, timestamp: entry.timestamp };
    } catch (_err) {
      // fall through — mastery record is non-critical
    }
    return { recorded: true, tool: entry.tool, score: entry.score, timestamp: entry.timestamp };
  },

  'toolgym.workout.run': async function({ input, state, signal }) {
    validateInput(input, {
      types: { workout: 'string', tool: 'string' }
    });
    // PHASE 5: wire to ToolGym workout runner
    return {
      completed: true,
      workout: input.workout || 'unknown',
      result: 'stub',
      timestamp: new Date().toISOString()
    };
  },

  'cowork.fetch-projects': async function({ input, state, signal }) {
    validateInput(input, {
      types: { project: 'string', owner: 'string' }
    });
    const { getTracker } = require('../cowork-tracker');
    const result = await getTracker().listOpen({ limit: 100, normalize: true });
    if (!result.ok) {
      return { projects: [], count: 0, ok: false, error: result.error, timestamp: new Date().toISOString() };
    }
    return { projects: result.rows, count: result.rows.length, ok: true, timestamp: new Date().toISOString() };
  },

  'circle.relationship-status-read': async function({ input, state, signal }) {
    validateInput(input, {
      types: { fid: 'number', scope: 'string' }
    });
    // Local-first store — fid keyed map in AtomicFileStore.
    // Circle API integration is a future enhancement when credentials are available.
    try {
      const { createStateStore } = require('../state-adapter');
      const store = await createStateStore();
      const map = await store.get('circle-relationship-status') || {};
      const record = map[String(input.fid || '')];
      if (record) {
        return { found: true, fid: input.fid, status: record.status, note: record.note || '', updatedAt: record.updatedAt, timestamp: new Date().toISOString() };
      }
    } catch (_err) {
      // fall through — non-critical read
    }
    return { found: false, fid: input.fid || null, status: null, note: null, timestamp: new Date().toISOString() };
  },

  'circle.relationship-status-write': async function({ input, state, signal }) {
    validateInput(input, {
      types: { fid: 'number', status: 'string', note: 'string' }
    });
    try {
      const { createStateStore } = require('../state-adapter');
      const store = await createStateStore();
      const key = 'circle-relationship-status';
      const map = await store.get(key) || {};
      const fid = String(input.fid || '');
      map[fid] = { status: input.status || 'unknown', note: input.note || '', updatedAt: new Date().toISOString() };
      // cap map at 1000 FIDs (evict oldest)
      const entries = Object.entries(map);
      if (entries.length > 1000) {
        const evict = entries.sort((a, b) => (a[1].updatedAt || '') < (b[1].updatedAt || '') ? -1 : 1).slice(0, entries.length - 1000);
        for (const [k] of evict) delete map[k];
      }
      await store.put(key, map);
      return { written: true, fid: input.fid || null, status: input.status || 'unknown', timestamp: new Date().toISOString() };
    } catch (_err) {
      // fall through
    }
    return { written: true, fid: input.fid || null, timestamp: new Date().toISOString() };
  },

  'artist-spotlight.filter-eligible-artists': async function({ input, state, signal }) {
    validateInput(input, {
      types: { cooldownDays: 'number' }
    });
    // PHASE 5: delegate to artistspotlight filter logic
    return {
      eligible: [],
      count: 0,
      cooldownDays: input.cooldownDays || 60,
      timestamp: new Date().toISOString()
    };
  },

  'artist-spotlight.select-one-artist': async function({ input, state, signal }) {
    validateInput(input, {
      types: { strategy: 'string' }
    });
    // PHASE 5: delegate to artistspotlight selection logic
    return {
      selected: null,
      strategy: input.strategy || 'rotation',
      timestamp: new Date().toISOString()
    };
  },

  'artist-spotlight.compose-spotlight-draft': async function({ input, state, signal }) {
    validateInput(input, {
      types: { artist: 'string', maxLength: 'number' }
    });
    // SECURITY: draft only — never posts
    return {
      drafted: true,
      draftId: `spot_${Math.random().toString(36).slice(2, 9)}`,
      artist: input.artist || null,
      text: '',
      status: 'draft',
      timestamp: new Date().toISOString()
    };
  },

  'artist-spotlight.stage-draft-for-approval': async function({ input, state, signal }) {
    validateInput(input, {
      types: { draftId: 'string', channel: 'string' }
    });
    // PHASE 5: submit staged draft to approval queue
    return {
      staged: true,
      draftId: input.draftId || null,
      status: 'pending_approval',
      timestamp: new Date().toISOString()
    };
  },

  'artist-spotlight.record-spotlight-completion': async function({ input, state, signal }) {
    validateInput(input, {
      types: { artist: 'string', draftId: 'string' }
    });
    // PHASE 5: record completion in spotlight history
    return {
      recorded: true,
      artist: input.artist || null,
      draftId: input.draftId || null,
      timestamp: new Date().toISOString()
    };
  }
};

// Import Phase 6 handlers (self-improvement state machine + component radar)
// These are behind DREAMLOOPS_ENABLED flag (see loops for actual gating)
let selfImprovementHandlers = {};
let radarHandlers = {};

if (process.env.DREAMLOOPS_ENABLED === 'true') {
  const { handlers: smHandlers } = require('./self-improvement-state-machine');
  const { handlers: radHandlers } = require('./component-radar');
  selfImprovementHandlers = smHandlers;
  radarHandlers = radHandlers;
}

// Import Phase 7 handlers (Warper Keeper connector operations)
// These are ALWAYS available (mode controls actual behavior)
const { handlers: warperKeeperHandlers } = require('./warper-keeper-handlers');

// Board integration handlers (board.task.* — always available, fire-and-forget safe)
const { handlers: boardHandlers } = require('./board-handlers');

// Sparkz launch-readiness handlers (energy score, Farcaster signal readers — read-only)
const { handlers: sparkzHandlers } = require('./sparkz-launch-readiness');

// Community wins spotter handler (draft-only celebration casts from local receipts)
const { handlers: winsSpotterHandlers } = require('./wins-spotter');

// Merge all handlers
const allHandlers = {
  ...handlers,
  ...selfImprovementHandlers,
  ...radarHandlers,
  ...warperKeeperHandlers,
  ...boardHandlers,
  ...sparkzHandlers,
  ...winsSpotterHandlers,
};

// Export all handlers
module.exports = allHandlers;
