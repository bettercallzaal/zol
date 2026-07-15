#!/usr/bin/env node

/**
 * zao-wins-spotter.js - Community Wins Spotlight Loop Handler
 *
 * Discovers underappreciated wins from ZAO community via Bonfire shared-graph memory,
 * detects patterns, and drafts genuine celebration casts.
 *
 * Modes: disabled, dry_run, draft_only (default)
 * Output: ~/zol/drafts/wins-spotlight-YYYY-MM-DD.md
 *
 * Usage:
 *   node scripts/zao-wins-spotter.js
 *   DL_MODE=dry_run node scripts/zao-wins-spotter.js
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

// ============================================================================
// Config & Env
// ============================================================================

const MODE = process.env.DL_MODE || process.env.MODE || 'draft_only';
const BONFIRE_API_KEY = process.env.BONFIRE_API_KEY || '';
const BONFIRE_ID = process.env.BONFIRE_ID || '';
const BONFIRE_API_URL = process.env.BONFIRE_API_URL || 'https://tnt-v2.api.bonfires.ai';
const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY || '';
const DRAFT_DIR = path.resolve(process.env.HOME || '/root', 'zol', 'drafts');

// Secret patterns to reject
const SECRET_PATTERNS = [
  /[0-9a-fA-F]{64}/,
  /sk-[a-zA-Z0-9_-]+/,
  /ghp_[a-zA-Z0-9_-]+/,
  /PRIVATE\s*KEY/i,
];

function containsSecret(text) {
  const str = typeof text === 'string' ? text : JSON.stringify(text);
  return SECRET_PATTERNS.some((re) => re.test(str));
}

// ============================================================================
// Helpers
// ============================================================================

async function fetchJson(url, options = {}) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const protocol = urlObj.protocol === 'https:' ? https : require('http');

    const requestOptions = {
      hostname: urlObj.hostname,
      port: urlObj.port,
      path: urlObj.pathname + urlObj.search,
      method: options.method || 'GET',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'zao-wins-spotter/1.0',
        ...options.headers,
      },
      timeout: options.timeout || 10_000,
    };

    const req = protocol.request(requestOptions, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch (e) {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`Request timeout after ${options.timeout || 10_000}ms`));
    });

    if (options.body) {
      req.write(typeof options.body === 'string' ? options.body : JSON.stringify(options.body));
    }

    req.end();
  });
}

async function delveBonfire(query) {
  if (!BONFIRE_API_KEY || !BONFIRE_ID) {
    console.warn('[WinsSpotter] Bonfire credentials missing, skipping query');
    return { episodes: [] };
  }

  console.log(`[WinsSpotter] Querying Bonfire: "${query}"`);

  try {
    const result = await fetchJson(`${BONFIRE_API_URL}/delve`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${BONFIRE_API_KEY}`,
      },
      body: JSON.stringify({
        bonfire_id: BONFIRE_ID,
        query,
      }),
      timeout: 15_000,
    });

    if (result.status !== 200) {
      throw new Error(`Bonfire returned HTTP ${result.status}`);
    }

    const episodes = result.body.episodes || [];
    console.log(`[WinsSpotter] Found ${episodes.length} episodes`);
    return { episodes };
  } catch (error) {
    console.error(`[WinsSpotter] Bonfire query failed: ${error.message}`);
    return { episodes: [] };
  }
}

// ============================================================================
// Win Parsing & Scoring
// ============================================================================

function parseWinEpisode(episode) {
  const name = episode.name || '';
  const content = episode.content || episode.summary || '';
  const timestamp = new Date(episode.created_at || episode.updated_at || new Date()).toISOString();

  // Detect win signals in content
  const winSignals = [
    { regex: /launch|shipped|deploy/i, weight: 0.25 },
    { regex: /win|success|achieve|complete/i, weight: 0.2 },
    { regex: /breakthrough|discover|integration/i, weight: 0.2 },
    { regex: /built|created|finished|booked/i, weight: 0.15 },
    { regex: /community|team|partner/i, weight: 0.1 },
  ];

  let score = 0.3; // Base score
  for (const signal of winSignals) {
    if (signal.regex.test(content)) score += signal.weight;
  }

  // Boost for specific product mentions
  if (/ZAO|ZABAL|WaveWarZ|COC Concertz|POIDH|Juke|Magnetiq|Fractal/i.test(content)) {
    score += 0.15;
  }

  // Penalize if it's clearly from an automated system
  if (/automated|bot|system/i.test(name)) score *= 0.8;

  return {
    name,
    content: content.slice(0, 500), // Truncate for context
    score: Math.min(score, 1.0),
    timestamp,
    fullContent: content,
  };
}

function detectPatterns(wins) {
  if (wins.length === 0) return { patterns: [] };

  const patterns = [];
  const contentJoined = wins.map((w) => w.content).join(' ');

  // Detect themes
  const themes = {
    'music_focus': /music|sound|audio|song|beats/i,
    'builder_energy': /build|launch|ship|create/i,
    'community_vibes': /community|collaborate|together|support/i,
    'web3_momentum': /crypto|onchain|contract|token|web3/i,
  };

  for (const [theme, regex] of Object.entries(themes)) {
    const matches = (contentJoined.match(regex) || []).length;
    if (matches > 0) {
      patterns.push({ theme, strength: Math.min(matches / 5, 1.0) });
    }
  }

  return { patterns: patterns.sort((a, b) => b.strength - a.strength) };
}

// ============================================================================
// Context Loading (ICM boxes)
// ============================================================================

async function loadZaoContext() {
  // In a real implementation, this would fetch ICM boxes from useicm.com
  // For now, return hardcoded context about ZAO ecosystem
  return {
    zao: {
      name: 'The ZAO',
      members: 188,
      focus: 'web3 music culture and builder community',
      brands: ['COC Concertz', 'WaveWarZ', 'ZABAL Games'],
    },
    voice: {
      style: 'genuine-joyful',
      tone: 'no emojis, no em dashes, clear and actionable',
      approach: 'celebrate specific people and wins, not generic praise',
    },
  };
}

// ============================================================================
// Draft Composition (via OpenRouter LLM)
// ============================================================================

async function draftCelebration(wins, patterns, context) {
  if (!OPENROUTER_KEY) {
    console.warn('[WinsSpotter] OpenRouter key missing, generating template draft');
    return generateTemplateDraft(wins, patterns, context);
  }

  const topWins = wins.slice(0, 3);
  const topPattern = patterns.patterns[0];

  const prompt = `You are ZOL, the ZAO community curator. Your job is to celebrate genuine wins discovered in the ZAO ecosystem.

ZAO Context:
- Name: The ZAO
- Focus: Web3 music culture and builder community
- Brands: COC Concertz, WaveWarZ, ZABAL Games

Today's Wins Discovered:
${topWins.map((w, i) => `${i + 1}. ${w.content}`).join('\n')}

Dominant Pattern: ${topPattern?.theme || 'diverse community activity'}

Your Task:
Draft a single Farcaster cast (280 chars max) that celebrates these wins. Be GENUINE and SPECIFIC:
- Name specific people or projects if mentioned
- Avoid generic praise like "amazing" or "keep building"
- Use the tone: clear, joyful, actionable
- No emojis, no em dashes, no rhetorical flourishes
- Make Zaal smile when he reads it

IMPORTANT: If you cannot mention specific people/projects from the wins, say so and decline to draft.

Draft:`;

  try {
    const response = await fetchJson('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${OPENROUTER_KEY}`,
      },
      body: JSON.stringify({
        model: 'openrouter/auto',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 300,
        temperature: 0.8,
      }),
      timeout: 45_000,
    });

    if (response.status !== 200) {
      throw new Error(`OpenRouter returned HTTP ${response.status}`);
    }

    const content = response.body.choices?.[0]?.message?.content || '';
    return content.trim();
  } catch (error) {
    console.error(`[WinsSpotter] LLM draft failed: ${error.message}, using template`);
    return generateTemplateDraft(wins, patterns, context);
  }
}

function generateTemplateDraft(wins, patterns, context) {
  if (wins.length === 0) {
    return 'No wins discovered yet. The ZAO is always building.';
  }

  const topWin = wins[0];
  const topPattern = patterns.patterns[0];

  let draft = `Spotted in the ZAO today:\n\n`;
  draft += `${topWin.content.slice(0, 200)}`;

  if (topPattern) {
    draft += `\n\nPattern: ${topPattern.theme} is strong in the ecosystem right now.`;
  }

  return draft;
}

// ============================================================================
// Draft Validation & Storage
// ============================================================================

function validateDraft(draft) {
  const issues = [];

  if (!draft || draft.length < 10) {
    issues.push('Draft too short');
  }

  if (draft.length > 1000) {
    issues.push('Draft too long');
  }

  if (containsSecret(draft)) {
    issues.push('Draft contains secret pattern');
  }

  // Check for emoji characters (Unicode ranges for emoji)
  const emojiRegex = /[\u{1F300}-\u{1F9FF}]|[\u{2600}-\u{27BF}]|[\u{1F900}-\u{1F9FF}]/gu;
  if (emojiRegex.test(draft)) {
    issues.push('Draft contains emoji');
  }

  return {
    valid: issues.length === 0,
    issues,
  };
}

async function storeDraft(draft, wins, patterns, receipt) {
  await fs.promises.mkdir(DRAFT_DIR, { recursive: true });

  const date = new Date().toISOString().split('T')[0];
  const draftPath = path.join(DRAFT_DIR, `wins-spotlight-${date}.md`);

  const markdown = `# Community Wins Spotlight - ${date}

## Draft Cast
${draft}

## Context
- Wins found: ${wins.length}
- Top pattern: ${patterns.patterns[0]?.theme || 'diverse'}
- Generated: ${new Date().toISOString()}

## Wins Discovered
${wins
  .slice(0, 5)
  .map((w, i) => `${i + 1}. **${w.name}** (score: ${w.score.toFixed(2)})\n   ${w.content}`)
  .join('\n\n')}

---
Mode: ${MODE}
Status: DRAFT - pending human approval for posting
`;

  await fs.promises.writeFile(draftPath, markdown, { mode: 0o600 });
  console.log(`[WinsSpotter] Draft stored: ${draftPath}`);

  receipt.draftPath = draftPath;
  receipt.draftUrl = `file://${draftPath}`;
}

// ============================================================================
// Receipt & State
// ============================================================================

async function recordReceipt(receipt) {
  const stateDir = path.join(process.env.HOME || '/root', 'zol', 'state');
  await fs.promises.mkdir(stateDir, { recursive: true });

  const date = new Date().toISOString().slice(0, 10);
  const receiptPath = path.join(stateDir, `receipt-wins-${date}.json`);

  await fs.promises.writeFile(receiptPath, JSON.stringify(receipt, null, 2), { mode: 0o600 });
  console.log(`[WinsSpotter] Receipt saved: ${receiptPath}`);
}

// ============================================================================
// Main Loop Handler
// ============================================================================

async function main() {
  console.log(`[WinsSpotter] Starting in mode: ${MODE}`);

  if (MODE === 'disabled') {
    console.log('[WinsSpotter] Loop disabled, exiting');
    process.exit(0);
  }

  const receipt = {
    timestamp: new Date().toISOString(),
    mode: MODE,
    steps: [],
  };

  try {
    // Step 1: Query Bonfire
    console.log('[WinsSpotter] Step 1/7: Querying Bonfire...');
    const query = 'community wins, achievements, breakthroughs, launches from the last 24 hours';
    const { episodes } = await delveBonfire(query);
    receipt.steps.push({ id: 'bonfire-query', status: 'success', episodesFound: episodes.length });

    // Step 2: Parse & Score
    console.log(`[WinsSpotter] Step 2/7: Parsing ${episodes.length} episodes...`);
    const wins = episodes
      .map((ep) => parseWinEpisode(ep))
      .filter((w) => w.score >= 0.7)
      .sort((a, b) => b.score - a.score);
    receipt.steps.push({ id: 'parse-episodes', status: 'success', winsFound: wins.length });

    if (wins.length === 0) {
      console.log('[WinsSpotter] No high-scoring wins found, gracefully exiting');
      receipt.steps.push({ id: 'draft-composition', status: 'skipped', reason: 'no-wins' });
      await recordReceipt(receipt);
      process.exit(0);
    }

    // Step 3: Detect Patterns
    console.log('[WinsSpotter] Step 3/7: Detecting patterns...');
    const patterns = detectPatterns(wins);
    receipt.steps.push({
      id: 'pattern-detection',
      status: 'success',
      patternsFound: patterns.patterns.length,
    });

    // Step 4: Load Context
    console.log('[WinsSpotter] Step 4/7: Loading ZAO context...');
    const context = await loadZaoContext();
    receipt.steps.push({ id: 'context-load', status: 'success' });

    // Step 5: Draft Celebration
    console.log('[WinsSpotter] Step 5/7: Composing celebration cast...');
    const draft = await draftCelebration(wins, patterns, context);
    receipt.steps.push({ id: 'draft-composition', status: 'success', draftLength: draft.length });

    // Step 6: Validate
    console.log('[WinsSpotter] Step 6/7: Validating draft...');
    const validation = validateDraft(draft);
    if (!validation.valid) {
      console.error(`[WinsSpotter] Validation failed: ${validation.issues.join(', ')}`);
      receipt.steps.push({ id: 'draft-validation', status: 'failed', issues: validation.issues });
      await recordReceipt(receipt);
      process.exit(1);
    }
    receipt.steps.push({ id: 'draft-validation', status: 'success' });

    // Step 7: Store
    console.log('[WinsSpotter] Step 7/7: Storing draft...');
    if (MODE === 'draft_only') {
      await storeDraft(draft, wins, patterns, receipt);
      console.log('[WinsSpotter] Draft ready for Zaal to review and approve for posting');
    } else if (MODE === 'dry_run') {
      console.log('[WinsSpotter] DRY RUN - would store draft:');
      console.log(draft);
    }
    receipt.steps.push({ id: 'draft-storage', status: 'success' });

    receipt.finalStatus = 'success';
    receipt.winsDiscovered = wins.length;
    receipt.draftGenerated = true;

    await recordReceipt(receipt);
    console.log('[WinsSpotter] Loop completed successfully');
    process.exit(0);
  } catch (error) {
    console.error(`[WinsSpotter] Loop failed: ${error.message}`);
    receipt.error = error.message;
    receipt.finalStatus = 'failed';
    await recordReceipt(receipt);
    process.exit(1);
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error('Unhandled error:', error);
    process.exit(1);
  });
}

module.exports = { delveBonfire, parseWinEpisode, detectPatterns, draftCelebration, validateDraft };
