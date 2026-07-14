// zol-learn-zaal.js - ZOL learns from Zaal's Farcaster posts, and quote-casts every 4th
// strong one with its own thoughts (amplifies the founder voice).
//
// Loop (every 30 min): pull Zaal's recent ORIGINAL casts (fid 19640, skip replies), summarize
// each into ~/zol/zaal-learnings.md (ZOL learning Zaal's world), judge if it is quote-worthy,
// and on every 4th quote-worthy one, generate a genuine ZOL comment and quote-cast it.
// Seeds seen-set on first run, so it only acts on posts made from now on (no backlog blast).
//
// AUTO by default (Zaal asked ZOL to do this; it amplifies his own verified content). Each
// quote-cast pings Zaal so he can course-correct (or delete via zol-delete). Set
// ZOL_QUOTECAST_DRAFT=1 to stage + approve instead of auto-post.
const fs = require('fs');
const L = require('../src/zol-lib');
const H = process.env.HOME, ZAAL = 19640, HAATZ = 'https://haatz.quilibrium.com';
const tg = L.envfile(H + '/.zao/private/tg.env');
const DRAFT_ONLY = process.env.ZOL_QUOTECAST_DRAFT === '1';
const SEEN = H + '/zol/.learn-zaal-seen', STATE = H + '/zol/.learn-zaal-state.json', LEARN = H + '/zol/zaal-learnings.md';
const DRAFTS = H + '/zol/drafts';
fs.mkdirSync(DRAFTS, { recursive: true });
const persona = () => { try { return fs.readFileSync(H + '/zol/zol-persona.md', 'utf8'); } catch (e) { return 'You are ZOL, the ZAO scout. Plain, no emojis, no em dashes.'; } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function send(t){try{await fetch('https://api.telegram.org/bot'+tg.ZOE_BOT_TOKEN+'/sendMessage',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({chat_id:tg.ZAAL_TELEGRAM_ID,text:t})});}catch(e){}}
function loadState(){ try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch (e) { return { good: 0 }; } }
function saveState(s){ try { fs.writeFileSync(STATE, JSON.stringify(s)); } catch (e) {} }
async function zaalCasts(){
  // Neynar (Haatz returns non-JSON for this fid). Original casts only (skip replies).
  const r = await fetch('https://api.neynar.com/v2/farcaster/feed/user/casts?fid=' + ZAAL + '&limit=25', { headers: { 'x-api-key': L.KEY, accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
  const j = await r.json();
  return (j.casts || []).filter(c => !c.parent_hash).map(c => ({ hash: c.hash, text: c.text || '' }));
}
(async () => {
  if (!fs.existsSync(SEEN)) {
    try { const c = await zaalCasts(); fs.writeFileSync(SEEN, (c.map(x => x.hash).join('\n')) + '\n'); } catch (e) { fs.writeFileSync(SEEN, ''); }
    await send('ZOL now learning from Zaal Farcaster posts, quote-casting every 4th strong one' + (DRAFT_ONLY ? ' (DRAFT mode - pings to approve).' : ' with its thoughts (auto).'));
  }
  let fails = 0;
  for (;;) {
    try {
      const casts = await zaalCasts(); fails = 0;
      let seen = fs.readFileSync(SEEN, 'utf8');
      const st = loadState();
      for (const c of casts.slice().reverse()) { // oldest-first among the batch
        if (!c.hash || seen.indexOf(c.hash) >= 0) continue;
        fs.appendFileSync(SEEN, c.hash + '\n'); seen += c.hash + '\n';
        if (!c.text || c.text.trim().length < 12) continue;
        const summary = await L.ork('Summarize what this Farcaster post by Zaal (ZAO founder) is about in one plain sentence. No preamble.', c.text, { max: 60 });
        if (summary) { const day = new Date().toISOString().slice(0, 10); try { fs.appendFileSync(LEARN, '- (' + day + ') ' + summary.replace(/\n/g, ' ') + '\n'); } catch (e) {} }
        const verdict = await L.ork('Is this Farcaster post substantive and quote-worthy - a real take, update, or idea, NOT a greeting, one-liner, or throwaway reply? Answer only YES or NO.', c.text, { max: 5 });
        if (!verdict || !/^\s*yes/i.test(verdict)) continue;
        st.good = (st.good || 0) + 1; saveState(st);
        if (st.good % 4 !== 0) continue;
        const thought = await L.ork(persona() + '\n\nZaal (ZAO founder) posted the message below. Write ZOL\'s quote-cast comment: ONE genuine added angle or builder tie-in, max 220 chars, plain, no emojis, no em dashes, no @, not sycophantic. Output only the comment.', c.text, { max: 120, temp: 0.8 });
        if (!thought) continue;
        if (DRAFT_ONLY) {
          fs.writeFileSync(DRAFTS + '/qc-' + c.hash + '.json', JSON.stringify({ quote: true, text: thought, quotedFid: ZAAL, quotedHash: c.hash }));
          await send('ZOL quote-cast DRAFT (4th good Zaal post):\nHis: "' + c.text.slice(0, 140) + '"\nZOL: "' + thought + '"\nApprove: ssh zaal@ansuz "cd ~/zol/farcaster-agent && node zol-quote.js ' + ZAAL + ' ' + c.hash + ' \\"' + thought.replace(/"/g, '') + '\\""');
        } else {
          try { await L.quoteCast({ text: thought, quotedFid: ZAAL, quotedHash: c.hash }); await send('ZOL quote-cast a Zaal post (every-4th-good):\nHis: "' + c.text.slice(0, 120) + '"\nZOL: "' + thought + '"'); }
          catch (e) { await send('ZOL quote-cast failed: ' + ((e && e.message) || e)); }
        }
      }
    } catch (e) { fails++; if (fails % 3 === 0) await send('ZOL learn-zaal: ' + fails + ' errors in a row, last: ' + ((e && e.message) || e)); }
    await sleep(1800000); // 30 min
  }
})();
