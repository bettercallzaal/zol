// zol-threads.js - ZOL thread awareness + feedback learning.
//
// The existing zol-reply.js only sees @mentions and skips Zaal. This daemon covers the gap:
// it watches REPLIES to ZOL's own casts (Neynar notifications, type=replies) so thread
// conversation never goes unanswered.
//
//  - Reply from ZAAL (fid 19640) = FEEDBACK: distill it into one imperative rule, append to
//    zol-persona.md (every ZOL script reads persona -> the lesson compounds everywhere), and
//    auto-reply a short ack (safe: it is the operator).
//  - Reply from anyone else: draft a reply, stage it, ping Zaal to approve (gated, same as mentions).
//
// SAFETY: no spend/launch/sign tool exists here. Bot-blocklist FIDs skipped. Generated @ stripped.
// First run SEEDS the seen-set from current notifications, so it never re-answers old replies.
const fs = require('fs');
const H = process.env.HOME, FID = 3338501, ZAAL = 19640, NEYNAR = 'https://api.neynar.com';
function envfile(p){const o={};try{for(const l of fs.readFileSync(p,'utf8').split('\n')){const m=l.match(/^([A-Z_]+)=(.*)$/);if(m)o[m[1]]=m[2].trim();}}catch(e){}return o;}
const tg = envfile(H + '/.zao/private/tg.env');
const KEY = envfile(H + '/.zao/private/neynar.env').NEYNAR_API_KEY;
const ORK = (() => { try { return fs.readFileSync(H + '/.zao/private/openrouter.key', 'utf8').trim(); } catch (e) { return ''; } })();
const PERSONA = H + '/zol/zol-persona.md';
const BLOCK = (() => { try { return new Set(JSON.parse(fs.readFileSync(H + '/zol/bot-blocklist.json', 'utf8')).fids || []); } catch (e) { return new Set([874542, 886870]); } })();
const SEEN = H + '/zol/.threads-seen', DRAFTS = H + '/zol/drafts';
const HUB = 'https://hub-api.neynar.com';
const { makeCastAdd, NobleEd25519Signer, FarcasterNetwork, Message, CastType } = require('@farcaster/hub-nodejs');
fs.mkdirSync(DRAFTS, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function send(t){try{await fetch('https://api.telegram.org/bot'+tg.ZOE_BOT_TOKEN+'/sendMessage',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({chat_id:tg.ZAAL_TELEGRAM_ID,text:t})});}catch(e){}}
function persona(){ try { return fs.readFileSync(PERSONA, 'utf8'); } catch (e) { return 'You are ZOL, ZAO scout. Plain, no emojis, no em dashes.'; } }

async function ork(sys, user, max){
  if (!ORK) return null;
  try {
    const r = await fetch('https://openrouter.ai/api/v1/chat/completions', { method: 'POST', headers: { Authorization: 'Bearer ' + ORK, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: process.env.OPENROUTER_MODEL || 'anthropic/claude-fable-5', messages: [{ role: 'system', content: sys }, { role: 'user', content: user }], max_tokens: max || 120, temperature: 0.6 }), signal: AbortSignal.timeout(40000) });
    const b = await r.json();
    let t = b.choices && b.choices[0] && b.choices[0].message && b.choices[0].message.content;
    return t ? t.trim().replace(/^["']|["']$/g, '') : null;
  } catch (e) { return null; }
}

async function postReply(parentFid, parentHash, text){
  const signerHex = JSON.parse(fs.readFileSync(H + '/.openclaw/farcaster-credentials.json', 'utf8')).signerPrivateKey;
  const signer = new NobleEd25519Signer(Buffer.from(signerHex, 'hex'));
  const t = text.replace(/@(\w)/g, '$1').slice(0, 320);
  const cast = { text: t, embeds: [], embedsDeprecated: [], mentions: [], mentionsPositions: [], parentCastId: { fid: parentFid, hash: Buffer.from(parentHash.replace(/^0x/, ''), 'hex') }, type: CastType.CAST };
  const m = await makeCastAdd(cast, { fid: FID, network: FarcasterNetwork.MAINNET }, signer);
  if (m.isErr()) throw new Error(m.error.message);
  const res = await fetch(HUB + '/v1/submitMessage', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'x-api-key': KEY }, body: Buffer.from(Message.encode(m.value).finish()) });
  if (!res.ok) throw new Error('hub ' + res.status);
  return t;
}

// Distill Zaal feedback into an imperative rule + append to persona (dedup). Returns the rule or null.
async function learn(feedback){
  const rule = await ork('Turn this feedback for a Farcaster posting agent into ONE short imperative rule. Max 16 words. No preamble, no quotes. If it is not actionable guidance, output NONE.', feedback, 40);
  if (!rule || /^none\b/i.test(rule)) return null;
  const p = persona();
  const key = rule.toLowerCase().replace(/[^a-z0-9 ]/g, '').slice(0, 40);
  if (p.toLowerCase().replace(/[^a-z0-9 ]/g, '').includes(key)) return null; // already learned
  const day = new Date().toISOString().slice(0, 10);
  const marker = '## Learned rules (from Zaal feedback)';
  let np = p.indexOf(marker) >= 0 ? p : (p.replace(/\s*$/, '') + '\n\n' + marker + '\n');
  np = np.replace(/\s*$/, '') + '\n- ' + rule + ' (' + day + ')\n';
  fs.writeFileSync(PERSONA, np);
  return rule;
}

(async () => {
  if (!KEY) { await send('ZOL threads: no Neynar key, cannot watch replies.'); return; }
  async function notifs(){
    const r = await fetch(NEYNAR + '/v2/farcaster/notifications?fid=' + FID + '&type=replies&limit=25', { headers: { 'x-api-key': KEY, accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
    const j = await r.json();
    return (j.notifications || []).map(n => n.cast).filter(Boolean);
  }
  if (!fs.existsSync(SEEN)) {
    try { const c = await notifs(); fs.writeFileSync(SEEN, c.map(x => x.hash).join('\n') + '\n'); } catch (e) { fs.writeFileSync(SEEN, ''); }
    await send('ZOL thread-awareness live. Watching replies to ZOL casts. Your feedback -> auto-ack + learned into persona; others -> drafted + gated.');
  }
  let fails = 0;
  for (;;) {
    try {
      const casts = await notifs();
      fails = 0;
      let seen = fs.readFileSync(SEEN, 'utf8');
      for (const c of casts) {
        const h = c.hash; if (!h || seen.indexOf(h) >= 0) continue;
        fs.appendFileSync(SEEN, h + '\n'); seen += h + '\n';
        const afid = c.author && c.author.fid;
        const text = c.text || '';
        if (BLOCK.has(afid)) continue;
        if (afid === ZAAL) {
          const rule = await learn(text);
          // Operator feedback is absorbed SILENTLY: ZOL learns it into its persona
          // and confirms to Zaal privately on Telegram. It does NOT post a public
          // ack reply - a flat "got it" clutters Farcaster and is off-brand for a
          // music scout. A good agent knows when not to reply. (2026-07-13)
          await send('ZOL learned from you' + (rule ? (': "' + rule + '" (added to persona)') : ' (no new rule)') + '\nYou said: "' + text.slice(0, 160) + '"\n(Absorbed silently - no public reply posted.)');
        } else {
          const reply = await ork(persona() + '\n\nSomeone replied to your cast. Draft ONE reply, max 300 chars, plain, no emojis, no em dashes, no @, no preamble. Output only the reply.', text, 300);
          if (reply) {
            const r2 = reply.replace(/@(\w)/g, '$1').slice(0, 320);
            fs.writeFileSync(DRAFTS + '/' + h + '.json', JSON.stringify({ text: r2, parentFid: afid, parentHash: h }));
            await send('ZOL thread reply from fid ' + afid + ':\n"' + text.slice(0, 180) + '"\n\nDraft:\n' + r2 + '\n\nApprove:\nssh zaal@ansuz "cd ~/zol/farcaster-agent && node post-reply.js ' + h + '"');
          }
        }
      }
    } catch (e) { fails++; if (fails % 3 === 0) { try { await send('ZOL threads: ' + fails + ' errors in a row, last: ' + ((e && e.message) || e)); } catch (_) {} } }
    await sleep(180000);
  }
})();
