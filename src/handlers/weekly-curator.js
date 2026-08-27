// src/handlers/weekly-curator.js - Weekly curator handlers for ZOL recap loop
// Handlers: state read/write, farcaster.activity-read, message.classify, priority.plan
// No signer access. No auto-send (draft-only, always staged for approval).
// State carries over week-by-week to prevent duplicate highlights.

const fs = require('fs');
const path = require('path');

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

// Weekly recap stages
const RECAP_STAGES = {
  collect: {
    description: 'Read last 7 days of ZOL casts',
    action: 'read recent-casts.json',
  },
  contextualize: {
    description: 'Query Bonfire for weekly ZAO ecosystem context',
    action: 'recall query for standout tracks and artist wins',
  },
  highlight: {
    description: 'Select the single best find of the week',
    action: 'classify and rank casts',
  },
  draft: {
    description: 'Compose weekly recap text (280 chars)',
    action: 'write recap cast text',
  },
  stage: {
    description: 'Write draft to state for human approval',
    action: 'persist to ~/zol/drafts/<hash>.json',
  },
};

// Session-level state for testing (in production, this is backed by state-adapter)
// Note: Handlers are stateless - they read state from input and return new state
// The DreamLoop orchestrator persists state between steps via state-adapter
const sessionState = {
  summarizedWeeks: [],
  lastHighlightHash: null,
  runTimestamp: new Date().toISOString(),
};

// Handlers exported for the weekly-curator loop
const weeklycurator = {
  // Read state (already-summarized weeks, to avoid repeats)
  'state.local.read': async function({ input, state, signal }) {
    validateInput(input, {
      types: { key: 'string', includeHistory: 'boolean' }
    });

    const timeoutHandle = signal ? () => {
      throw new Error('state.local.read timed out');
    } : null;
    signal?.addEventListener('abort', timeoutHandle, { once: true });

    try {
      const { key, includeHistory } = input;

      if (key === 'weekly-curator-state') {
        // Return state tracking already-summarized weeks
        return {
          success: true,
          key,
          state: {
            summarizedWeeks: sessionState.summarizedWeeks,
            lastHighlightHash: sessionState.lastHighlightHash,
            lastRunTimestamp: sessionState.runTimestamp,
          },
          timestamp: new Date().toISOString(),
        };
      }

      return {
        success: true,
        key,
        state: {},
        timestamp: new Date().toISOString(),
      };
    } finally {
      if (timeoutHandle && signal) signal.removeEventListener('abort', timeoutHandle);
    }
  },

  // Write state (carryover for next week, track that this week was summarized)
  'state.local.write': async function({ input, state, executionMode, signal }) {
    validateInput(input, {
      required: ['key'],
      types: { key: 'string', updateType: 'string', draftOnly: 'boolean' }
    });

    // Guard: reject secret patterns
    if (executionMode !== 'mock') {
      const secretPattern = /[0-9a-fA-F]{64}|sk-[a-zA-Z0-9_-]+|ghp_[a-zA-Z0-9_-]+/;
      if (secretPattern.test(JSON.stringify(input))) {
        throw new Error('[SECURITY] Refusing to persist state with secret pattern');
      }
    }

    const { key, updateType, draftOnly, kind } = input;

    // Special handling for draft staging
    if (key === 'weekly-curator-draft') {
      if (!draftOnly) {
        throw new Error('[SAFETY] weekly-curator-draft must be draftOnly=true, never auto-post');
      }

      // In production, this would write to ~/zol/drafts/<hash>.json
      return {
        success: true,
        key,
        draftOnly: true,
        kind: kind || 'weekly-recap',
        status: 'staged-for-approval',
        timestamp: new Date().toISOString(),
        note: 'Draft staged in ~/zol/drafts/ for Zaal to review and post via post-event.js',
      };
    }

    // State carryover: record this week as summarized
    if (key === 'weekly-curator-state' && updateType === 'week-summarized') {
      const weekNumber = Math.floor(Date.now() / (7 * 24 * 60 * 60 * 1000));
      // Note: In production, this is persisted by state-adapter
      // For testing, we return the update but don't modify shared sessionState
      return {
        success: true,
        key,
        updateType,
        immutableLog: true,
        weekNumber,
        timestamp: new Date().toISOString(),
        note: 'Week recorded as summarized; next run will check this list to avoid repeats',
      };
    }

    return {
      success: true,
      key,
      updateType: updateType || 'updated',
      timestamp: new Date().toISOString(),
    };
  },

  // Read ZOL's recent activity (casts from the last 7 days)
  'farcaster.activity-read': async function({ input, state, signal }) {
    validateInput(input, {
      types: {
        source: 'string',
        timeWindowDays: 'number',
        query: 'string',
      }
    });

    const timeoutHandle = signal ? () => {
      throw new Error('farcaster.activity-read timed out');
    } : null;
    signal?.addEventListener('abort', timeoutHandle, { once: true });

    try {
      const { source, timeWindowDays = 7, query } = input;

      if (source === 'recent-casts-file') {
        // In production, read from ~/zol/recent-casts.json
        // For now, return mock recent casts from the past 7 days
        const mockCasts = [
          {
            text: 'Joseph Goats just dropped the smoothest lo-fi beat I have heard all month. Artist spotlight.',
            ts: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString(),
          },
          {
            text: 'WaveWarZ Round 3 results are in. These battle tracks are fire.',
            ts: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
          },
          {
            text: 'COC Concertz lineup just dropped. The ZAO summer is heating up.',
            ts: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(),
          },
          {
            text: 'ZABAL Games workshop next week. Builders unite.',
            ts: new Date(Date.now() - 4 * 24 * 60 * 60 * 1000).toISOString(),
          },
          {
            text: 'New track from Huöttöja is essential listening.',
            ts: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString(),
          },
          {
            text: 'SongJam collab just dropped. Proof that DAOs can create music.',
            ts: new Date(Date.now() - 6 * 24 * 60 * 60 * 1000).toISOString(),
          },
          {
            text: 'ZOE is the currency. SANG is the score. Music is the game.',
            ts: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
          },
        ];

        return {
          success: true,
          source,
          casts: mockCasts,
          castCount: mockCasts.length,
          timeWindowDays,
          timestamp: new Date().toISOString(),
        };
      }

      if (source === 'bonfire-recall') {
        // In production, call Bonfire API with the recall query
        // For now, return mock Bonfire context
        const bonfireContext = `
ZAO Music Curator Report for the Week:
- Joseph Goats released a breakthrough lo-fi production that resonates with the ZAO ethos
- WaveWarZ rounds continue to showcase emerging artist talent
- COC Concertz bringing major ZAO acts to live performance
- ZABAL Games workshop series building creator tools
- Huöttöja collaboration extending ZAO sound design
- SongJam pioneering DAO-based music creation model
        `.trim();

        return {
          success: true,
          source,
          query,
          context: bonfireContext,
          timestamp: new Date().toISOString(),
        };
      }

      return {
        success: true,
        source,
        timestamp: new Date().toISOString(),
      };
    } finally {
      if (timeoutHandle && signal) signal.removeEventListener('abort', timeoutHandle);
    }
  },

  // Classify and rank casts to select the best find of the week
  'message.classify': async function({ input, state, signal }) {
    validateInput(input, {
      required: ['types'],
      types: { types: 'object', contextKey: 'string' }
    });

    const timeoutHandle = signal ? () => {
      throw new Error('message.classify timed out');
    } : null;
    signal?.addEventListener('abort', timeoutHandle, { once: true });

    try {
      const { types, contextKey } = input;

      if (contextKey === 'weekly-curator-highlight') {
        // Classify which cast is the best find of the week
        // In production, this would use LLM classification or scoring
        const classifications = {
          'best-find-of-week': {
            selected: 'Joseph Goats just dropped the smoothest lo-fi beat I have heard all month. Artist spotlight.',
            score: 0.95,
            reason: 'Fresh artist spotlight with concrete reference to a track',
          },
          'artist-spotlight': {
            selected: 'Huöttöja collaboration extending ZAO sound design',
            score: 0.85,
          },
          'track-recommendation': {
            selected: 'New track from Huöttöja is essential listening.',
            score: 0.80,
          },
        };

        return {
          success: true,
          contextKey,
          classifications,
          timestamp: new Date().toISOString(),
        };
      }

      if (contextKey === 'weekly-recap-similarity') {
        // Check if the draft is too similar to previous recaps
        // In production, use word-overlap similarity guard (like in zol-daily.js)
        return {
          success: true,
          contextKey,
          isSimilar: false,
          similarityScore: 0.15,
          threshold: 0.5,
          timestamp: new Date().toISOString(),
        };
      }

      return {
        success: true,
        contextKey,
        classifications: {},
        timestamp: new Date().toISOString(),
      };
    } finally {
      if (timeoutHandle && signal) signal.removeEventListener('abort', timeoutHandle);
    }
  },

  // Plan the recap composition and check for duplicate weeks
  'priority.plan': async function({ input, state, signal }) {
    validateInput(input, {
      required: ['scope'],
      types: { scope: 'string', checkForDuplicateWeek: 'boolean', draftOnly: 'boolean' }
    });

    const timeoutHandle = signal ? () => {
      throw new Error('priority.plan timed out');
    } : null;
    signal?.addEventListener('abort', timeoutHandle, { once: true });

    try {
      const { scope, checkForDuplicateWeek, draftOnly, maxLength } = input;

      if (scope === 'weekly-recap-check') {
        // Check if this calendar week has already been summarized
        const weekNumber = Math.floor(Date.now() / (7 * 24 * 60 * 60 * 1000));
        // Get summarizedWeeks from passed state, or empty array if not provided
        const summarizedWeeks = (state && state.summarizedWeeks) || sessionState.summarizedWeeks || [];
        const alreadySummarized = summarizedWeeks.includes(weekNumber);

        if (alreadySummarized && checkForDuplicateWeek) {
          return {
            success: true,
            scope,
            canProceed: false,
            reason: 'This week has already been summarized',
            weekNumber,
            timestamp: new Date().toISOString(),
          };
        }

        return {
          success: true,
          scope,
          canProceed: true,
          weekNumber,
          timestamp: new Date().toISOString(),
        };
      }

      if (scope === 'weekly-recap-composition') {
        // Plan the recap text composition
        if (draftOnly === false) {
          throw new Error('[SAFETY] weekly-recap composition must be draftOnly=true, never auto-post');
        }

        const recapText = 'Joseph Goats just dropped the smoothest lo-fi beat of the week. ZAO music at its finest.';

        return {
          success: true,
          scope,
          draftText: recapText,
          textLength: recapText.length,
          maxLength: maxLength || 280,
          draftOnly: true,
          timestamp: new Date().toISOString(),
        };
      }

      return {
        success: true,
        scope,
        timestamp: new Date().toISOString(),
      };
    } finally {
      if (timeoutHandle && signal) signal.removeEventListener('abort', timeoutHandle);
    }
  },

  // Log weekly recap events
  'log.zol-events-write': async function({ input, state, executionMode, signal }) {
    validateInput(input, {
      required: ['eventType'],
      types: { eventType: 'string', includeResult: 'boolean' }
    });

    // Guard: no secrets in logs
    if (executionMode !== 'mock') {
      const secretPattern = /[0-9a-fA-F]{64}|sk-[a-zA-Z0-9_-]+|ghp_[a-zA-Z0-9_-]+/;
      if (secretPattern.test(JSON.stringify(input))) {
        throw new Error('[SECURITY] Refusing to log event with secret pattern');
      }
    }

    const { eventType, includeResult } = input;

    // PHASE 5: wire to actual ZOL event log
    // For now, return structured result
    return {
      success: true,
      eventType,
      logged: true,
      timestamp: new Date().toISOString(),
      includeResult: includeResult || false,
      note: 'Event logged; draft is awaiting Zaal approval',
    };
  },
};

module.exports = { weeklycurator, RECAP_STAGES };
