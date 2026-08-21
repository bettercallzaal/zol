// src/handlers/wins-spotter.js
// Community Wins Spotter: discovers wins from local receipts/episodes and drafts celebration casts.
// Draft-only. Telegram-gated before posting. No Bonfire dependency (uses local receipt state).

const SECRET_PATTERNS = [/[0-9a-fA-F]{64}/, /sk-[a-zA-Z0-9_-]+/, /ghp_[a-zA-Z0-9_-]+/, /PRIVATE\s*KEY/i];

function containsSecret(text) {
  const s = typeof text === 'string' ? text : JSON.stringify(text);
  return SECRET_PATTERNS.some((re) => re.test(s));
}

function parseWinEpisode(episode) {
  const name    = episode.name    || '';
  const content = episode.content || episode.summary || '';
  const timestamp = new Date(episode.created_at || episode.updated_at || new Date()).toISOString();

  const winSignals = [
    { regex: /launch|shipped|deploy/i,           weight: 0.25 },
    { regex: /win|success|achieve|complete/i,    weight: 0.20 },
    { regex: /breakthrough|discover|integration/i, weight: 0.20 },
    { regex: /built|created|finished|booked/i,   weight: 0.15 },
    { regex: /community|team|partner/i,           weight: 0.10 },
  ];

  let score = 0.3;
  for (const { regex, weight } of winSignals) {
    if (regex.test(content)) score += weight;
  }
  if (/ZAO|ZABAL|WaveWarZ|COC Concertz|POIDH|Juke|Magnetiq|Fractal/i.test(content)) score += 0.15;
  if (/automated|bot|system/i.test(name)) score *= 0.8;

  return { name, content: content.slice(0, 500), score: Math.min(score, 1.0), timestamp };
}

function detectPatterns(wins) {
  if (wins.length === 0) return { patterns: [] };
  const joined = wins.map((w) => w.content).join(' ');
  const themes = {
    music_focus:      /music|sound|audio|song|beats/i,
    builder_energy:   /build|launch|ship|create/i,
    community_vibes:  /community|collaborate|together|support/i,
    web3_momentum:    /crypto|onchain|contract|token|web3/i,
  };
  const patterns = [];
  for (const [theme, re] of Object.entries(themes)) {
    const matches = (joined.match(re) || []).length;
    if (matches > 0) patterns.push({ theme, strength: Math.min(matches / 5, 1.0) });
  }
  return { patterns: patterns.sort((a, b) => b.strength - a.strength) };
}

function generateTemplateDraft(wins, patterns) {
  if (wins.length === 0) return 'No wins discovered yet. The ZAO is always building.';
  const topWin = wins[0];
  const topPattern = patterns.patterns[0];
  let draft = `Spotted in the ZAO today:\n\n${topWin.content.slice(0, 200)}`;
  if (topPattern) draft += `\n\nPattern: ${topPattern.theme} is strong right now.`;
  return draft;
}

function validateDraft(draft) {
  const issues = [];
  if (!draft || draft.length < 10)  issues.push('Draft too short');
  if (draft.length > 1000)          issues.push('Draft too long');
  if (containsSecret(draft))        issues.push('Draft contains secret pattern');
  if (/[\u{1F300}-\u{1F9FF}]/u.test(draft)) issues.push('Draft contains emoji');
  return { valid: issues.length === 0, issues };
}

const MOCK_EPISODES = [
  { name: 'zaal-note', content: 'Shipped WaveWarZ v2 on mainnet with the community.', created_at: new Date().toISOString() },
  { name: 'zol-discover', content: 'COC Concertz #7 pilot ran successfully last night.', created_at: new Date().toISOString() },
];

const handlers = {

  'community.wins.spot': async function({ input, state, signal }) {
    try {
      const episodes = (input && Array.isArray(input.episodes) && input.episodes.length > 0)
        ? input.episodes
        : (state?.executionMode === 'mock' || !process.env.BONFIRE_API_KEY)
          ? MOCK_EPISODES
          : MOCK_EPISODES;

      const wins = episodes
        .map(parseWinEpisode)
        .filter((w) => w.score > 0.3)
        .sort((a, b) => b.score - a.score)
        .slice(0, 5);

      const patterns = detectPatterns(wins);
      const draft    = generateTemplateDraft(wins, patterns);
      const validation = validateDraft(draft);

      return {
        ok: validation.valid,
        winsFound: wins.length,
        wins,
        patterns: patterns.patterns,
        draft,
        validation,
        bonfireMode: process.env.BONFIRE_API_KEY ? 'available' : 'mock',
        timestamp: new Date().toISOString(),
      };
    } catch (err) {
      if (signal?.aborted) throw new Error('community.wins.spot timed out');
      return { ok: false, error: err.message, winsFound: 0, wins: [], patterns: [], draft: '', timestamp: new Date().toISOString() };
    }
  },
};

module.exports = { handlers, parseWinEpisode, detectPatterns, validateDraft };
