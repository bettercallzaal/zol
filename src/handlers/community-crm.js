// src/handlers/community-crm.js - Community CRM handlers for relationship lifecycle loop
// Handlers: relationship.read/write, message.classify, priority.plan, farcaster.dm-send (draft-only)
// No signer access. No auto-send (draft-only for bulk). Relationship state is immutable log-based.

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

// Relationship lifecycle stage definitions
const RELATIONSHIP_STAGES = {
  discover: {
    criteria: 'joined_recently_or_low_activity',
    action: 'welcome-dm-and-intro-link',
    autoSend: true,
  },
  engage: {
    criteria: 'active_participant',
    action: 'invite-to-next-sync-or-workshop',
    autoSend: false,
    requiresApproval: true,
  },
  coordinate: {
    criteria: 'active_in_project',
    action: 'surface-related-projects',
    autoSend: true,
  },
  escalate: {
    criteria: 'leadership_or_high_value',
    action: 'flag-for-zaal-strategic-call',
    autoSend: false,
    requiresApproval: true,
  },
  nurture: {
    criteria: 'was_active_now_inactive',
    action: 'gentle-reengagement-dm',
    autoSend: false,
    requiresApproval: true,
  },
};

// Rate limiting state (in-memory for this session; persisted via state-adapter in production)
const rateLimitState = {
  dmsToday: 0,
  updatesToday: 0,
  lastResetDate: new Date().toISOString().split('T')[0],
};

// Handlers exported for the relationship-lifecycle-update loop
const communitycrm = {
  // Read relationship status and history
  'circle.relationship-status-read': async function({ input, state, signal }) {
    validateInput(input, {
      required: ['memberId'],
      types: { memberId: 'string' }
    });

    const timeoutHandle = signal ? () => {
      throw new Error('circle.relationship-status-read timed out');
    } : null;
    signal?.addEventListener('abort', timeoutHandle, { once: true });

    try {
      const { memberId } = input;

      // PHASE 5: wire to actual circle state/API
      // For now, return structured mock
      const relationshipData = {
        memberId,
        stage: 'engage',
        joinedAt: new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString(),
        lastActionDate: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
        lastAction: 'invite-sent',
        activityScore: 7,
        history: [
          { date: new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString(), event: 'member-joined' },
          { date: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(), event: 'invite-sent' },
        ],
        flaggedForEscalation: false,
      };

      return {
        success: true,
        relationship: relationshipData,
        timestamp: new Date().toISOString(),
      };
    } finally {
      if (timeoutHandle && signal) signal.removeEventListener('abort', timeoutHandle);
    }
  },

  // Write relationship status (immutable log-based)
  'circle.relationship-status-write': async function({ input, state, executionMode, signal }) {
    validateInput(input, {
      required: ['memberId', 'updateType'],
      types: { memberId: 'string', updateType: 'string' }
    });

    // Guard: reject secret patterns
    if (executionMode !== 'mock') {
      const secretPattern = /[0-9a-fA-F]{64}|sk-[a-zA-Z0-9_-]+|ghp_[a-zA-Z0-9_-]+/;
      if (secretPattern.test(JSON.stringify(input))) {
        throw new Error('[SECURITY] Refusing to persist relationship data with secret pattern');
      }
    }

    const { memberId, updateType } = input;

    // PHASE 5: wire to actual circle state-adapter
    // For now, log and return structured result
    return {
      success: true,
      memberId,
      updateType,
      immutableLog: true,
      timestamp: new Date().toISOString(),
      note: 'Relationship status updates are immutable logs; no member data erasure',
    };
  },

  // Classify message/action type for relationship stage
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
      const { types, contextKey, draftOnly } = input;

      // PHASE 5: wire to actual LLM classification if needed
      // For now, return mock classification
      const classifications = {};
      if (Array.isArray(types)) {
        types.forEach((type) => {
          classifications[type] = Math.random() > 0.5;
        });
      }

      return {
        success: true,
        classifications,
        draftOnly: draftOnly !== false,
        timestamp: new Date().toISOString(),
      };
    } finally {
      if (timeoutHandle && signal) signal.removeEventListener('abort', timeoutHandle);
    }
  },

  // Plan relationship action based on stage
  'priority.plan': async function({ input, state, signal }) {
    validateInput(input, {
      required: ['scope'],
      types: { scope: 'string', stageAware: 'boolean' }
    });

    const timeoutHandle = signal ? () => {
      throw new Error('priority.plan timed out');
    } : null;
    signal?.addEventListener('abort', timeoutHandle, { once: true });

    try {
      const { scope, stageAware, gateType, threshold } = input;

      // Plan an action based on scope
      if (scope === 'relationship-lifecycle-action') {
        return {
          success: true,
          scope,
          actionProposed: 'nurture-dm-draft',
          stageAware: stageAware || false,
          priority: 'medium',
          timestamp: new Date().toISOString(),
        };
      }

      if (scope === 'approval-decision') {
        const needsApproval = threshold && threshold <= 10;
        return {
          success: true,
          scope,
          gateType: gateType || 'none',
          requiresApproval: needsApproval,
          threshold: threshold || 0,
          timestamp: new Date().toISOString(),
        };
      }

      return {
        success: true,
        scope,
        action: 'none-needed',
        timestamp: new Date().toISOString(),
      };
    } finally {
      if (timeoutHandle && signal) signal.removeEventListener('abort', timeoutHandle);
    }
  },

  // Send DM (draft-only, never auto-send)
  'farcaster.dm-send': async function({ input, state, executionMode, signal }) {
    validateInput(input, {
      required: ['recipientFid', 'message'],
      types: { recipientFid: 'string', message: 'string', draftOnly: 'boolean' }
    });

    const timeoutHandle = signal ? () => {
      throw new Error('farcaster.dm-send timed out');
    } : null;
    signal?.addEventListener('abort', timeoutHandle, { once: true });

    try {
      const { recipientFid, message, draftOnly, requireApprovalIfBulk, maxPerBatch } = input;

      // SAFETY: Always draft, never auto-send
      if (!draftOnly) {
        throw new Error('[SAFETY] farcaster.dm-send is draft-only; never auto-send DMs');
      }

      // Check rate limits
      if (rateLimitState.dmsToday >= 500) {
        throw new Error('DM rate limit exceeded (500/day)');
      }

      // If bulk send approval gate is set, enforce it
      if (requireApprovalIfBulk && maxPerBatch && maxPerBatch > 10) {
        return {
          success: true,
          recipientFid,
          status: 'staged-for-approval',
          draftOnly: true,
          requiresApproval: true,
          timestamp: new Date().toISOString(),
          note: 'Bulk DM send requires manual approval before sending',
        };
      }

      // Single DM auto-sends (low risk)
      rateLimitState.dmsToday += 1;

      return {
        success: true,
        recipientFid,
        status: 'draft-composed',
        draftOnly: true,
        message,
        timestamp: new Date().toISOString(),
        note: 'DM is drafted; Zaal reviews and approves in Telegram before sending',
      };
    } finally {
      if (timeoutHandle && signal) signal.removeEventListener('abort', timeoutHandle);
    }
  },

  // Event logging (immutable)
  'log.relationship-events-write': async function({ input, state, executionMode, signal }) {
    validateInput(input, {
      required: ['eventType'],
      types: { eventType: 'string', includeTimestamp: 'boolean' }
    });

    // Guard: no secrets in logs
    if (executionMode !== 'mock') {
      const secretPattern = /[0-9a-fA-F]{64}|sk-[a-zA-Z0-9_-]+|ghp_[a-zA-Z0-9_-]+/;
      if (secretPattern.test(JSON.stringify(input))) {
        throw new Error('[SECURITY] Refusing to log event with secret pattern');
      }
    }

    const { eventType, includeTimestamp, includeResult } = input;

    // PHASE 5: wire to actual event log store
    // For now, return structured result
    return {
      success: true,
      eventType,
      logged: true,
      timestamp: new Date().toISOString(),
      includeTimestamp: includeTimestamp || false,
      includeResult: includeResult || false,
      note: 'Event logged to immutable log; no deletion allowed',
    };
  },

  // Read Farcaster activity
  'farcaster.activity-read': async function({ input, state, signal }) {
    validateInput(input, {
      types: { maxRecent: 'number', includeProjectData: 'boolean' }
    });

    const timeoutHandle = signal ? () => {
      throw new Error('farcaster.activity-read timed out');
    } : null;
    signal?.addEventListener('abort', timeoutHandle, { once: true });

    try {
      const { maxRecent = 50, includeProjectData } = input;

      // PHASE 5: wire to actual Neynar API or cache
      // For now, return mock activity
      return {
        success: true,
        activities: [
          { date: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString(), type: 'cast', channel: 'zao' },
          { date: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(), type: 'like', content: 'music-post' },
        ],
        activityCount: 2,
        maxRecent,
        includeProjectData: includeProjectData || false,
        timestamp: new Date().toISOString(),
      };
    } finally {
      if (timeoutHandle && signal) signal.removeEventListener('abort', timeoutHandle);
    }
  },

  // Fetch member project contributions
  'cowork.fetch-projects': async function({ input, state, signal }) {
    validateInput(input, {
      types: { fetchMemberProjects: 'boolean' }
    });

    const timeoutHandle = signal ? () => {
      throw new Error('cowork.fetch-projects timed out');
    } : null;
    signal?.addEventListener('abort', timeoutHandle, { once: true });

    try {
      const { fetchMemberProjects } = input;

      // PHASE 5: wire to actual cowork tracker API
      // For now, return mock project data
      return {
        success: true,
        projects: [
          { id: 'proj-1', name: 'ZABAL Games Workshop', role: 'participant', since: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString() },
        ],
        projectCount: 1,
        fetchMemberProjects: fetchMemberProjects || false,
        timestamp: new Date().toISOString(),
      };
    } finally {
      if (timeoutHandle && signal) signal.removeEventListener('abort', timeoutHandle);
    }
  },
};

module.exports = { communitycrm, RELATIONSHIP_STAGES };
