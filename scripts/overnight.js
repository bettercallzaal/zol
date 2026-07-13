// ZOL overnight research loop. Discovers trending Base/agent-scene casts via haatz
// (free hub mirror), extracts themes, and drafts 5 cast ideas via OpenRouter (falls
// back to heuristic extraction if no key). Writes a report to review in the morning.
// No wallet, no signer, no on-chain action of any kind - read-only research + drafts.
const fs = require('fs');

const FID = parseInt(process.env.FID);
const MAX_RUNTIME_MS = (parseFloat(process.env.MAX_RUNTIME_H || '9')) * 3600e3;
const HAATZ = 'https://haatz.quilibrium.com';
const REPORT = process.env.HOME + '/zol/overnight_report.md';
const t0 = Date.now();
const ZAAL_FID = 19640; // @zaal
const CHANNELS = ['base', 'ai-agents', 'eliza', 'founders', 'ai', 'autonomous-worlds'];
const KW = ['base', 'agent', 'agents', 'eliza', 'autonomous', 'ai', 'onchain', 'llm', 'bot', 'mcp', 'crypto', 'build', 'ship', 'farcaster'];

function log(l) { const s = `- ${new Date().toISOString().slice(11, 19)} ${l}`; console.log(s); fs.appendFileSync(REPORT, s + '\n'); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
async function gj(u) { for (let i = 0; i < 3; i++) { try { const r = await fetch(u, { signal: AbortSignal.timeout(15000) }); if (r.ok) return await r.json(); } catch (e) {} await sleep(800); } return null; }

async function discover() {
  const tally = new Map(); const corpus = [];
  for (const ch of CHANNELS) {
    const j = await gj(`${HAATZ}/v1/castsByParent?url=${encodeURIComponent('https://warpcast.com/~/channel/' + ch)}&pageSize=60`);
    if (!j || !j.messages) { log(`channel ${ch}: no data`); continue; }
    let n = 0;
    for (const m of j.messages) { const fid = m.data?.fid; const txt = m.data?.castAddBody?.text || ''; if (!fid) continue; if (fid === FID) continue; tally.set(fid, (tally.get(fid) || 0) + 1); if (txt) corpus.push(txt); n++; }
    log(`channel ${ch}: ${n} casts, ${new Set(j.messages.map(m => m.data?.fid)).size} authors`);
    await sleep(800);
  }
  // seed from @bcz (Zaal) network - high-signal, aligned with Zaal
  try {
    const lf = await gj(`${HAATZ}/v1/linksByFid?fid=${ZAAL_FID}&link_type=follow&pageSize=1000`);
    if (lf && lf.messages) { let z = 0; for (const m of lf.messages) { const tf = m.data && m.data.linkBody && m.data.linkBody.targetFid; if (tf && tf !== FID) { tally.set(tf, (tally.get(tf) || 0) + 100); z++; } } log(`zaal(@bcz) follows seeded: ${z} (+100 each, rank first)`); }
    const zc = await gj(`${HAATZ}/v1/castsByFid?fid=${ZAAL_FID}&pageSize=30&reverse=1`);
    if (zc && zc.messages) { let n = 0; for (const m of zc.messages) { const t = m.data && m.data.castAddBody && m.data.castAddBody.text; if (t) { corpus.push('[zaal] ' + t); n++; } } log(`zaal casts for inspiration: ${n}`); }
  } catch (e) { log('zaal seed failed: ' + e.message.slice(0, 60)); }
  return { tally, corpus };
}

function themes(corpus) {
  const freq = new Map();
  for (const txt of corpus) { const low = txt.toLowerCase(); for (const k of KW) { if (low.includes(k)) freq.set(k, (freq.get(k) || 0) + 1); } }
  return [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
}

async function drafts(corpus, th) {
  const key = fs.existsSync(process.env.HOME + '/.zao/private/openrouter.key') ? fs.readFileSync(process.env.HOME + '/.zao/private/openrouter.key', 'utf8').trim() : '';
  const top = th.map(([k, c]) => `${k}(${c})`).join(', ');
  if (key) {
    try {
      const sample = corpus.slice(0, 40).map(s => s.replace(/\n/g, ' ').slice(0, 140)).join('\n');
      const r = await fetch('https://openrouter.ai/api/v1/chat/completions', { method: 'POST', headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: process.env.OPENROUTER_MODEL || 'anthropic/claude-fable-5', messages: [{ role: 'system', content: 'You are ZOL, the ZAO music scout on Farcaster. Voice: clear, no emojis, no em dashes, real opinions, music + builder energy. Draft 5 high-context Farcaster cast ideas (max 280 chars each) that connect the base/AI-agent/eliza/autonomous trends to ZAO music + builders. Output a numbered list only.' }, { role: 'user', content: `Trending themes: ${top}\n\nRecent casts sample:\n${sample}` }], max_tokens: 700, temperature: 0.85 }), signal: AbortSignal.timeout(40000) });
      const b = await r.json(); const txt = b.choices?.[0]?.message?.content; if (txt) return txt;
    } catch (e) { log('openrouter draft failed: ' + e.message.slice(0, 80)); }
  }
  // heuristic fallback
  return [
   `1. The top trend tonight is ${th[0]?.[0] || 'agents'}. ZAO angle: an agent that curates music for the ${th[0]?.[0] || 'base'} community.`,
   `2. Builders are shipping ${th[1]?.[0] || 'autonomous'} systems. ZOL take: autonomy means nothing without taste. Music needs both.`,
   `3. Eliza/agent talk is loud. ZAO question: who is the agent you actually enjoy talking to? Be that one.`,
   `4. ${th[2]?.[0] || 'onchain'} is trending. Tie-in: onchain music rights + artist tips, not speculation.`,
   `5. Recap: tonight base+AI builders converged on ${top}. ZAO ships music-native agents in that lane.`,
  ].join('\n');
}

(async () => {
  fs.writeFileSync(REPORT, `# ZOL overnight report\nstarted ${new Date().toISOString()} | fid=${FID}\n\n## Activity\n`);
  log('start (research-only, no wallet, no on-chain action)');
  const { tally, corpus } = await discover();
  log(`discovered ${tally.size} candidate accounts; corpus ${corpus.length} casts`);
  if (Date.now() - t0 > MAX_RUNTIME_MS) log('max runtime reached during discovery');
  const th = themes(corpus);
  log(`trending themes: ${th.map(([k, c]) => k + ':' + c).join(', ')}`);
  const d = await drafts(corpus, th);
  fs.appendFileSync(REPORT, `\n## Trending themes\n${th.map(([k, c]) => `- ${k}: ${c}`).join('\n')}\n\n## 5 cast drafts (for Zaal to review - none of these post themselves)\n${d}\n\n## Summary\n- candidate accounts seen: ${tally.size}\n- corpus casts: ${corpus.length}\n- ended: ${new Date().toISOString()}\n`);
  log('done. report at ~/zol/overnight_report.md');
})().catch(e => { log('FATAL ' + (e.message || e)); process.exit(1); });
