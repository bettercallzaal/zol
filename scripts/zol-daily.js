// zol-daily.js - ZOL's original casts. Recalls ZAO context from the ZABAL Bonfire
// graph, drafts an on-brand original cast (persona + hard content constraints),
// posts it FREE (self-signed + Neynar API key), logs to Bonfire, pings Zaal.
// Runs HOURLY on the day schedule (5am-10pm ET). Anti-spam is load-bearing here:
//   1) recent posted casts are injected into the prompt so the model writes
//      something DIFFERENT or outputs NOTHING (silent),
//   2) a word-overlap similarity guard skips near-duplicate drafts,
//   3) the recall query rotates by hour so each hour pulls different material.
// Net: it attempts hourly but only posts genuinely fresh material - volume
// self-limits to quality, it will NOT spam the same artist 17x/day.
// Zaal authorized full-auto 2026-07-12 (zol-golive) + hourly cadence
// (zol-cadence-live). Safety spine: no spend/launch/sign-tx, @-mentions stripped.
// Test without posting: ZOL_DRY=1 node zol-daily.js
const fs = require('fs');
const { makeCastAdd, NobleEd25519Signer, FarcasterNetwork, Message, CastType } = require('@farcaster/hub-nodejs');
const H = process.env.HOME, FID = 3338501, HUB = 'https://hub-api.neynar.com';
const BF_URL = 'https://tnt-v2.api.bonfires.ai';
const RECENT_PATH = H + '/zol/recent-casts.json';
const RECENT_KEEP = 24; // ~ last day of hourly casts
const DRY = process.env.ZOL_DRY === '1';

function envfile(p) { const o = {}; try { for (const l of fs.readFileSync(p, 'utf8').split('\n')) { const m = l.match(/^([A-Z_]+)=(.*)$/); if (m) o[m[1]] = m[2].trim(); } } catch (e) {} return o; }
const tg = envfile(H + '/.zao/private/tg.env');
const bf = envfile(H + '/.zao/private/bonfire.env');
const ny = envfile(H + '/.zao/private/neynar.env');
const ORK = (() => { try { return fs.readFileSync(H + '/.zao/private/openrouter.key', 'utf8').trim(); } catch (e) { return ''; } })();
const NEYNAR_KEY = ny.NEYNAR_API_KEY || '';
const TG_TOKEN = tg.ZOE_BOT_TOKEN || tg.TG_TOKEN || '';
const TG_CHAT = tg.ZAAL_TELEGRAM_ID || tg.TG_CHAT || '';
const persona = (() => { try { return fs.readFileSync(H + '/zol/zol-persona.md', 'utf8'); } catch (e) { return 'You are ZOL, the ZAO music scout. Clear, plain, no emojis, no em dashes.'; } })();

// Rotate the recall query by hour so hourly casts pull DIFFERENT material.
const RECALL_QUERIES = [
  'ZAO WaveWarZ artists and battle results this week',
  'COC Concertz shows and ZAO live events coming up',
  'ZAO music builders, new tracks, and releases this week',
  'ZAOstock October festival and ZAO community wins',
  'ZAO artists, collaborations, and community members to spotlight',
  'The ZAO mission, Respect governance, and what makes it different',
  'ZABAL Games builders and recent project ships',
  'ZAO ecosystem news, partnerships, and momentum this week',
];

async function ping(msg) { if (!TG_TOKEN || !TG_CHAT) return; try { await fetch('https://api.telegram.org/bot' + TG_TOKEN + '/sendMessage', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: TG_CHAT, text: msg }) }); } catch (e) {} }

function recentCasts() {
  try { const a = JSON.parse(fs.readFileSync(RECENT_PATH, 'utf8')); return Array.isArray(a) ? a.slice(-RECENT_KEEP) : []; } catch (e) { return []; }
}
function appendRecent(text) {
  const a = recentCasts(); a.push({ text, ts: new Date().toISOString() });
  try { fs.writeFileSync(RECENT_PATH, JSON.stringify(a.slice(-RECENT_KEEP), null, 2)); } catch (e) {}
}

// Word-overlap similarity guard: reject a draft that shares >50% of its
// meaningful words with any recent cast. Cheap defense against near-duplicates
// the model might slip through despite the "do not repeat" instruction.
function tooSimilar(text, recent) {
  const norm = (s) => (s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((w) => w.length > 3);
  const a = new Set(norm(text));
  if (a.size === 0) return false;
  for (const r of recent) {
    const b = new Set(norm(r.text));
    let inter = 0; for (const w of a) if (b.has(w)) inter++;
    const denom = Math.min(a.size, b.size) || 1;
    if (inter / denom > 0.5) return true;
  }
  return false;
}

async function recall(query) {
  try {
    const r = await fetch(BF_URL + '/delve', { method: 'POST', headers: { Authorization: 'Bearer ' + bf.BONFIRE_API_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ bonfire_id: bf.BONFIRE_ID, query }), signal: AbortSignal.timeout(30000) });
    const b = await r.json();
    return (b.episodes || []).slice(0, 12).map((e) => e.content || e.summary || '').filter(Boolean).join('\n').slice(0, 3500);
  } catch (e) { return ''; }
}

async function draft(ctx, recent) {
  const recentBlock = recent.length
    ? '\n\nRECENTLY POSTED (you already said these - do NOT repeat the same artist, angle, or fact; write about something DIFFERENT and fresh, or output NOTHING):\n' + recent.map((r) => '- ' + r.text).join('\n')
    : '';
  const sys = persona + '\n\nReal ZAO context from the Bonfire graph (use ONLY facts in here, do not invent):\n' + ctx + recentBlock + '\n\nYou are ZOL, a MUSIC CURATOR. Write ONE original cast in your lane: a song-of-the-day, an artist spotlight, or a concrete note about a specific ZAO / COC Concertz / WaveWarZ artist or track. RULES: name a SPECIFIC artist, track, or event from the context above. Be concrete, not abstract. Do NOT write vague aphorisms about curation, data, or visibility. Do NOT repeat anything from RECENTLY POSTED above - it must be a fresh topic or angle. Do NOT force it - if the context has nothing specific, real, AND new worth posting, output exactly the word NOTHING. Max 280 characters, and always end on a complete sentence (never cut off mid-word). No emojis, no em dashes, no hashtags, no @mentions, no jargon, no hype. Output ONLY the cast text or NOTHING.';
  const r = await fetch('https://openrouter.ai/api/v1/chat/completions', { method: 'POST', headers: { Authorization: 'Bearer ' + ORK, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: process.env.OPENROUTER_MODEL || 'anthropic/claude-fable-5', messages: [{ role: 'system', content: sys }, { role: 'user', content: 'Write this hour\'s cast.' }], max_tokens: 220, temperature: 0.85 }), signal: AbortSignal.timeout(45000) });
  const b = await r.json();
  let t = b.choices && b.choices[0] && b.choices[0].message && b.choices[0].message.content;
  if (!t) throw new Error('no draft from model');
  let out = t.trim().replace(/^["']|["']$/g, '').replace(/@(\w)/g, '$1');
  if (out.length > 280) { out = out.slice(0, 280).replace(/\s+\S*$/, ''); if (!/[.!?]$/.test(out)) out = out.replace(/[\s,;:-]+$/, '') + '.'; }
  return out;
}

async function post(text) {
  const signerHex = JSON.parse(fs.readFileSync(H + '/.openclaw/farcaster-credentials.json', 'utf8')).signerPrivateKey;
  const signer = new NobleEd25519Signer(Buffer.from(signerHex, 'hex'));
  const add = await makeCastAdd({ text, embeds: [], embedsDeprecated: [], mentions: [], mentionsPositions: [], type: CastType.CAST, parentUrl: 'https://farcaster.xyz/~/channel/zabal' }, { fid: FID, network: FarcasterNetwork.MAINNET }, signer);
  if (add.isErr()) throw new Error('makeCastAdd ' + add.error.message);
  const bytes = Message.encode(add.value).finish();
  const res = await fetch(HUB + '/v1/submitMessage', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'x-api-key': NEYNAR_KEY }, body: Buffer.from(bytes) });
  if (!res.ok) throw new Error('hub ' + res.status + ' ' + (await res.text()).slice(0, 140));
}

async function logBonfire(text) {
  try {
    await fetch(BF_URL + '/knowledge_graph/episode/create', { method: 'POST', headers: { Authorization: 'Bearer ' + bf.BONFIRE_API_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ bonfire_id: bf.BONFIRE_ID, name: 'zol-cast-' + new Date().toISOString().slice(0, 13), episode_body: 'ZOL cast: ' + text, source: 'text', source_description: 'zol-daily-cast' }), signal: AbortSignal.timeout(20000) });
  } catch (e) {}
}

(async () => {
  try {
    const hour = new Date().getUTCHours();
    const query = RECALL_QUERIES[hour % RECALL_QUERIES.length];
    const recent = recentCasts();
    const ctx = await recall(query);
    const text = await draft(ctx, recent);
    if (!text || /^nothing\b/i.test(text.trim())) {
      console.log('ZOL: nothing fresh to post this hour (stayed silent)');
      return;
    }
    if (tooSimilar(text, recent)) {
      console.log('ZOL: draft too similar to a recent cast (skipped):', text.slice(0, 70));
      return;
    }
    if (DRY) {
      console.log('[DRY] would post:', text);
      return;
    }
    await post(text);
    appendRecent(text);
    await logBonfire(text);
    fs.mkdirSync(H + '/zol/drafts', { recursive: true });
    fs.writeFileSync(H + '/zol/drafts/last-posted.json', JSON.stringify({ text, posted: new Date().toISOString() }, null, 2));
    await ping('ZOL posted (auto):\n\n' + text);
    console.log('POSTED:', text);
  } catch (e) {
    await ping('ZOL post failed: ' + ((e && e.message) || e));
    console.error('ERR', (e && e.message) || e);
    process.exit(1);
  }
})();
