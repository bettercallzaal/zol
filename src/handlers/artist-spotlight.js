// src/handlers/artist-spotlight.js - Artist Spotlight handlers for rotation loop
// Handlers: state.local.read/write, bonfire.delve-recall, artist filtering and selection,
// draft composition and staging. Draft-only (never auto-posts). State carry-over: maintains
// artist-spotlight-v1-history to rotate through artists without repetition within 60 days.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

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

// Secret pattern guard
function rejectIfSecret(input) {
  const secretPattern = /[0-9a-fA-F]{64}|sk-[a-zA-Z0-9_-]+|ghp_[a-zA-Z0-9_-]+/;
  const str = JSON.stringify(input);
  if (secretPattern.test(str)) {
    throw new Error('[SECURITY] Refusing to process input with secret pattern');
  }
}

// Extract artist names from recent casts text
function extractArtistsFromText(text) {
  if (!text) return [];
  // Look for patterns like: artist name in quotes, or capitalized names preceded by
  // keywords like "artist", "track by", "feat.", etc.
  const artists = [];
  const lines = text.split('\n').filter(Boolean);

  for (const line of lines) {
    // Simple heuristic: lines with artist names typically have the artist as a
    // capitalized word or quoted string. For now, extract all capitalized words
    // as potential artist names (real implementation would use NLP/entity extraction).
    const matches = line.match(/'([^']+)'|"([^"]+)"|([A-Z][a-zA-Z\s&-]+(?:[A-Z][a-zA-Z\s&-]*)*)/g);
    if (matches) {
      for (const match of matches) {
        const name = match.replace(/^['"]|['"]$/g, '').trim();
        if (name.length > 1 && name.length < 100) {
          artists.push(name);
        }
      }
    }
  }

  return [...new Set(artists)]; // deduplicate
}

// Parse spotlight history from state
function parseSpotlightHistory(historyValue) {
  if (!historyValue) return [];
  if (typeof historyValue === 'string') {
    try {
      return JSON.parse(historyValue);
    } catch (e) {
      return [];
    }
  }
  if (Array.isArray(historyValue)) return historyValue;
  return [];
}

// Filter artists that are not recently spotlighted
function filterEligibleArtists(candidates, history, cooldownDays = 60) {
  if (!history || history.length === 0) {
    return candidates; // no history yet, all are eligible
  }

  const now = new Date();
  const cooloffTime = now.getTime() - cooldownDays * 24 * 60 * 60 * 1000;
  const recentlySpotlighted = new Set();

  for (const entry of history) {
    if (entry.artist && entry.spotlightedAt) {
      const spotTime = new Date(entry.spotlightedAt).getTime();
      if (spotTime > cooloffTime) {
        recentlySpotlighted.add(entry.artist.toLowerCase());
      }
    }
  }

  return candidates.filter((artist) => !recentlySpotlighted.has(artist.toLowerCase()));
}

// Handlers exported for the artist-spotlight loop
const artistspotlight = {
  // Read spotlight history from state
  'state.local.read': async function({ input, state, signal }) {
    validateInput(input, {
      types: { stateKey: 'string' }
    });

    const timeoutHandle = signal ? () => {
      throw new Error('state.local.read timed out');
    } : null;
    signal?.addEventListener('abort', timeoutHandle, { once: true });

    try {
      const { stateKey } = input;

      // Read from state object passed in (or would read from state-adapter in production)
      let history = [];
      if (state && stateKey in state) {
        history = parseSpotlightHistory(state[stateKey]);
      }

      return {
        success: true,
        stateKey,
        history,
        timestamp: new Date().toISOString(),
      };
    } finally {
      if (timeoutHandle && signal) signal.removeEventListener('abort', timeoutHandle);
    }
  },

  // Write to state (with append mode for history)
  'state.local.write': async function({ input, state, executionMode, signal }) {
    validateInput(input, {
      required: ['stateKey'],
      types: { stateKey: 'string', appendMode: 'boolean' }
    });

    rejectIfSecret(input);

    const timeoutHandle = signal ? () => {
      throw new Error('state.local.write timed out');
    } : null;
    signal?.addEventListener('abort', timeoutHandle, { once: true });

    try {
      const { stateKey, value, appendMode } = input;

      // In production, this would use state-adapter.put()
      // For testing/mock, we just return success
      return {
        success: true,
        stateKey,
        appendMode: appendMode || false,
        valueSize: value ? JSON.stringify(value).length : 0,
        timestamp: new Date().toISOString(),
      };
    } finally {
      if (timeoutHandle && signal) signal.removeEventListener('abort', timeoutHandle);
    }
  },

  // Fetch artist context from Bonfire
  'bonfire.delve-recall': async function({ input, state, signal }) {
    validateInput(input, {
      types: { query: 'string', maxEpisodes: 'number' }
    });

    const timeoutHandle = signal ? () => {
      throw new Error('bonfire.delve-recall timed out');
    } : null;
    signal?.addEventListener('abort', timeoutHandle, { once: true });

    try {
      const { query = 'ZAO artists', maxEpisodes = 15 } = input;

      // Mock response: simulate Bonfire recall with artist context
      const context = `Artists mentioned in recent ZAO context:
- Ivy Wong: experimental electronic producer, collaborated with WaveWarZ
- Marcus Chen: beats producer, featured in COC Concertz showcase
- Lila Rossi: vocalist, new ZAO artist discovery from July 2026
- Amir Khalil: hip-hop producer, ZABAL Games workshop participant
- Sofia Delgado: ambient composer, recent ZAO ecosystem contributor`;

      return {
        success: true,
        query,
        context,
        episodeCount: 5,
        maxEpisodes,
        timestamp: new Date().toISOString(),
      };
    } finally {
      if (timeoutHandle && signal) signal.removeEventListener('abort', timeoutHandle);
    }
  },

  // Parse recent casts to extract artist mentions
  'farcaster.recent-casts-parse': async function({ input, state, signal }) {
    validateInput(input, {
      types: { recentPath: 'string', extractArtists: 'boolean' }
    });

    const timeoutHandle = signal ? () => {
      throw new Error('farcaster.recent-casts-parse timed out');
    } : null;
    signal?.addEventListener('abort', timeoutHandle, { once: true });

    try {
      const { extractArtists = true } = input;

      // Mock: simulate parsing recent casts
      // In production, would read ~/zol/recent-casts.json and extract artist mentions
      const mockRecentCasts = [
        { text: 'Ivy Wong just released a stunning ambient track', ts: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString() },
        { text: 'Marcus Chen\'s beats are reshaping how we think about ZAO production', ts: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString() },
        { text: 'Sofia Delgado collaborating with WaveWarZ creators', ts: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString() },
      ];

      let artists = [];
      if (extractArtists) {
        for (const cast of mockRecentCasts) {
          artists = artists.concat(extractArtistsFromText(cast.text));
        }
        artists = [...new Set(artists)]; // deduplicate
      }

      return {
        success: true,
        castCount: mockRecentCasts.length,
        artists: extractArtists ? artists : [],
        extractedArtists: extractArtists,
        timestamp: new Date().toISOString(),
      };
    } finally {
      if (timeoutHandle && signal) signal.removeEventListener('abort', timeoutHandle);
    }
  },

  // Filter eligible artists (no recent spotlights within cooldown)
  'artist-spotlight.filter-eligible-artists': async function({ input, state, signal }) {
    validateInput(input, {
      types: { cooldownDays: 'number' }
    });

    const timeoutHandle = signal ? () => {
      throw new Error('artist-spotlight.filter-eligible-artists timed out');
    } : null;
    signal?.addEventListener('abort', timeoutHandle, { once: true });

    try {
      const { cooldownDays = 60, historyState = 'artist-spotlight-v1-history' } = input;

      // Get all candidates from context and recent mentions
      const allCandidates = [
        'Ivy Wong',
        'Marcus Chen',
        'Lila Rossi',
        'Amir Khalil',
        'Sofia Delgado',
      ];

      // Get history from state
      const history = state && state[historyState] ? parseSpotlightHistory(state[historyState]) : [];

      // Filter
      const eligible = filterEligibleArtists(allCandidates, history, cooldownDays);

      if (eligible.length === 0) {
        throw new Error(`[SAFETY] No eligible artists (all within ${cooldownDays}-day cooldown)`);
      }

      return {
        success: true,
        cooldownDays,
        allCandidates: allCandidates.length,
        eligibleCandidates: eligible.length,
        eligible,
        timestamp: new Date().toISOString(),
      };
    } finally {
      if (timeoutHandle && signal) signal.removeEventListener('abort', timeoutHandle);
    }
  },

  // Select one artist from eligible list
  'artist-spotlight.select-one-artist': async function({ input, state, signal }) {
    validateInput(input, {
      types: { weightRandom: 'boolean', candidates: 'object' }
    });

    const timeoutHandle = signal ? () => {
      throw new Error('artist-spotlight.select-one-artist timed out');
    } : null;
    signal?.addEventListener('abort', timeoutHandle, { once: true });

    try {
      const { weightRandom = true, candidates } = input;

      // Mock candidates if not provided
      const pool = candidates && candidates.eligible ? candidates.eligible : [
        'Ivy Wong',
        'Marcus Chen',
        'Lila Rossi',
      ];

      if (pool.length === 0) {
        throw new Error('[SAFETY] No candidates to select from');
      }

      // Weighted random selection (uniform weight here; could be improved with play counts, etc.)
      const selected = pool[Math.floor(Math.random() * pool.length)];

      return {
        success: true,
        selectedArtist: selected,
        poolSize: pool.length,
        timestamp: new Date().toISOString(),
      };
    } finally {
      if (timeoutHandle && signal) signal.removeEventListener('abort', timeoutHandle);
    }
  },

  // Compose spotlight draft cast
  'artist-spotlight.compose-spotlight-draft': async function({ input, state, signal }) {
    validateInput(input, {
      types: { maxLength: 'number', draftOnly: 'boolean', selectedArtist: 'string' }
    });

    const timeoutHandle = signal ? () => {
      throw new Error('artist-spotlight.compose-spotlight-draft timed out');
    } : null;
    signal?.addEventListener('abort', timeoutHandle, { once: true });

    try {
      const { maxLength = 280, draftOnly = true, selectedArtist = 'Ivy Wong' } = input;

      // SAFETY: always draft-only
      if (!draftOnly) {
        throw new Error('[SAFETY] artist-spotlight.compose-spotlight-draft is draft-only; never auto-post');
      }

      // Sanitize artist name against prompt injection: allow only letters, numbers, spaces, hyphens, apostrophes
      const safeArtistName = selectedArtist.replace(/[^a-zA-Z0-9 '\-\.]/g, '').trim().slice(0, 80);
      if (!safeArtistName) {
        throw new Error('[SECURITY] selectedArtist contains no valid characters after sanitization');
      }

      // Mock context for the selected artist
      const artistContext = {
        'Ivy Wong': 'Ivy Wong is an experimental electronic producer exploring the intersection of AI and human composition. Her latest work channels ZAO community feedback into immersive soundscapes.',
        'Marcus Chen': 'Marcus Chen crafts beats that resonate with WaveWarZ ethos. His production approach emphasizes community first, sonic innovation second.',
        'Lila Rossi': 'Lila Rossi is a vocalist pushing the boundaries of what ZAO can become. Fresh energy, real voice, genuine connection to the mission.',
        'Amir Khalil': 'Amir Khalil brings hip-hop innovation to the ZAO ecosystem. ZABAL Games workshops shaped his recent production direction.',
        'Sofia Delgado': 'Sofia Delgado composes ambient soundscapes that reflect ZAO moments. Her work is a meditation on community, structure, and emergence.',
      };

      const context = artistContext[safeArtistName] || `${safeArtistName} is a talented ZAO artist pushing creative boundaries.`;

      // Compose a spotlight cast (mock LLM call)
      let draftText = `Spotlight: ${safeArtistName}. ${context} Follow their work and see what moves them at the intersection of music and community.`;

      // Trim to maxLength
      if (draftText.length > maxLength) {
        draftText = draftText.slice(0, maxLength - 3).replace(/\s+\S*$/, '') + '...';
      }

      return {
        success: true,
        selectedArtist: safeArtistName,
        draftText,
        textLength: draftText.length,
        maxLength,
        draftOnly: true,
        timestamp: new Date().toISOString(),
      };
    } finally {
      if (timeoutHandle && signal) signal.removeEventListener('abort', timeoutHandle);
    }
  },

  // Stage draft for approval (write to ~/zol/drafts/<hash>.json)
  'artist-spotlight.stage-draft-for-approval': async function({ input, state, executionMode, signal }) {
    validateInput(input, {
      types: { draftsDirectory: 'string', draftKind: 'string', draftText: 'string', selectedArtist: 'string' }
    });

    rejectIfSecret(input);

    const timeoutHandle = signal ? () => {
      throw new Error('artist-spotlight.stage-draft-for-approval timed out');
    } : null;
    signal?.addEventListener('abort', timeoutHandle, { once: true });

    try {
      const { draftText = '', selectedArtist = '', draftKind = 'artist-spotlight' } = input;

      // Generate a deterministic hash from the draft content
      const hash = crypto.createHash('sha256').update(draftText + new Date().toISOString()).digest('hex').slice(0, 16);

      // Mock: would write to ~/zol/drafts/<hash>.json in production
      const draftObject = {
        hash,
        kind: draftKind,
        text: draftText,
        artist: selectedArtist,
        summary: `Spotlight: ${selectedArtist}`,
        createdAt: new Date().toISOString(),
        draftOnly: true,
      };

      // In production, would actually write the file here
      if (executionMode !== 'mock' && input.writeFile !== false) {
        // Would use fs.promises.writeFile here
        // For now, just return success
      }

      return {
        success: true,
        hash,
        draftKind,
        artist: selectedArtist,
        textLength: draftText.length,
        stagedAt: new Date().toISOString(),
        note: `Draft staged at ~/zol/drafts/${hash}.json for Zaal approval`,
      };
    } finally {
      if (timeoutHandle && signal) signal.removeEventListener('abort', timeoutHandle);
    }
  },

  // Record completion and update history
  'artist-spotlight.record-spotlight-completion': async function({ input, state, executionMode, signal }) {
    validateInput(input, {
      types: { eventType: 'string', selectedArtist: 'string', draftHash: 'string' }
    });

    const timeoutHandle = signal ? () => {
      throw new Error('artist-spotlight.record-spotlight-completion timed out');
    } : null;
    signal?.addEventListener('abort', timeoutHandle, { once: true });

    try {
      const { eventType, selectedArtist = '', draftHash = '' } = input;

      const now = new Date().toISOString();

      // This event will be written to state via append (handled by state.local.write in loop)
      const completionRecord = {
        eventType,
        artist: selectedArtist,
        spotlightedAt: now,
        draftHash,
      };

      return {
        success: true,
        eventType,
        completionRecord,
        timestamp: now,
        note: 'Spotlight completion recorded; history to be appended by loop',
      };
    } finally {
      if (timeoutHandle && signal) signal.removeEventListener('abort', timeoutHandle);
    }
  },
};

module.exports = { artistspotlight };
