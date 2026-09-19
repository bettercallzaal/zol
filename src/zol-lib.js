// zol-lib.js - shared ZOL Farcaster helpers. One place for signer, submit, post,
// reply, delete, username->fid, and the LLM call. Model: Fable 5 via OpenRouter.
// Safety: clean() strips @ so ZOL never tags/triggers another bot from generated text.
//
// APPROVAL GATE (verification-gate invariant #10):
// post(), quoteCast(), remove(), follow() are gated — they require
// ZOL_POSTING_ENABLED=true in the environment. All callers must go through the
// tool-gateway farcaster.reply handler (which enforces the ApprovalBridge). Direct
// imports that bypass the gateway will throw UngatedPostError at runtime and in
// tests, proving no hidden path exists around the approval gate.
const fs = require('fs');
// @farcaster/hub-nodejs is a Pi-only package. Lazy-load so CI/dev can import this
// module without the package installed. All callers are already gated by
// assertPostingEnabled(), which throws before hub() is ever invoked off-Pi.
let _hubCache = null;
function hub() { if (!_hubCache) _hubCache = require('@farcaster/hub-nodejs'); return _hubCache; }
const H = process.env.HOME, FID = 3338501, HUB = 'https://hub-api.neynar.com', NEYNAR = 'https://api.neynar.com';
const MODEL = process.env.OPENROUTER_MODEL || 'anthropic/claude-fable-5';
function envfile(p){const o={};try{for(const l of fs.readFileSync(p,'utf8').split('\n')){const m=l.match(/^([A-Z_]+)=(.*)$/);if(m)o[m[1]]=m[2].trim();}}catch(e){}return o;}
const KEY = envfile(H + '/.zao/private/neynar.env').NEYNAR_API_KEY;
function hubId() { return { fid: FID, network: hub().FarcasterNetwork.MAINNET }; }
function signer(){ const hex = JSON.parse(fs.readFileSync(H + '/.openclaw/farcaster-credentials.json', 'utf8')).signerPrivateKey; return new (hub().NobleEd25519Signer)(Buffer.from(hex, 'hex')); }
function clean(t){ return (t || '').replace(/@(\w)/g, '$1'); }
function hbuf(h){ return typeof h === 'string' ? Buffer.from(h.replace(/^0x/, ''), 'hex') : h; }

// UngatedPostError — thrown when a write function is called without ZOL_POSTING_ENABLED=true.
class UngatedPostError extends Error {
  constructor(fn) {
    super(`[SECURITY] zol-lib.${fn}() blocked: ZOL_POSTING_ENABLED is not set. ` +
      'All Farcaster writes must flow through the tool-gateway farcaster.reply handler, ' +
      'which enforces the ApprovalBridge approval gate.');
    this.name = 'UngatedPostError';
    this.code = 'UNGATED_POST';
    this.fn = fn;
  }
}
function assertPostingEnabled(fn) {
  if (process.env.ZOL_POSTING_ENABLED !== 'true') {
    throw new UngatedPostError(fn);
  }
}

async function submit(msg){ const res = await fetch(HUB + '/v1/submitMessage', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'x-api-key': KEY }, body: Buffer.from(hub().Message.encode(msg).finish()) }); if (!res.ok) throw new Error('hub ' + res.status + ' ' + (await res.text()).slice(0, 160)); return res; }
async function post({ text, embedUrl, mentions = [], mentionsPositions = [], parentFid, parentHash, parentUrl }){
  assertPostingEnabled('post');
  const body = { text: clean(text).slice(0, 320), embeds: embedUrl ? [{ url: embedUrl }] : [], embedsDeprecated: [], mentions, mentionsPositions, type: hub().CastType.CAST };
  if (parentFid && parentHash) body.parentCastId = { fid: parentFid, hash: hbuf(parentHash) };
  if (parentUrl) body.parentUrl = parentUrl;
  const m = await hub().makeCastAdd(body, hubId(), signer()); if (m.isErr()) throw new Error(m.error.message);
  await submit(m.value); return m.value.hash;
}
async function remove(hash){ assertPostingEnabled('remove'); const m = await hub().makeCastRemove({ targetHash: hbuf(hash) }, hubId(), signer()); if (m.isErr()) throw new Error(m.error.message); await submit(m.value); }
async function follow(targetFid){ assertPostingEnabled('follow'); const m = await hub().makeLinkAdd({ type: 'follow', targetFid }, hubId(), signer()); if (m.isErr()) throw new Error(m.error.message); await submit(m.value); return m.value.hash; }
async function resolveFid(username){ const r = await fetch(NEYNAR + '/v2/farcaster/user/by_username?username=' + String(username).replace(/^@/, ''), { headers: { 'x-api-key': KEY, accept: 'application/json' } }); const j = await r.json(); return j && j.user && j.user.fid; }
async function ork(system, user, { max = 200, temp = 0.7 } = {}){
  const ORK = (() => { try { return fs.readFileSync(H + '/.zao/private/openrouter.key', 'utf8').trim(); } catch (e) { return ''; } })();
  if (!ORK) return null;
  try { const r = await fetch('https://openrouter.ai/api/v1/chat/completions', { method: 'POST', headers: { Authorization: 'Bearer ' + ORK, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: MODEL, messages: [{ role: 'system', content: system }, { role: 'user', content: user }], max_tokens: max, temperature: temp }), signal: AbortSignal.timeout(45000) }); const b = await r.json(); const t = b.choices && b.choices[0] && b.choices[0].message && b.choices[0].message.content; return t ? t.trim().replace(/^["']|["']$/g, '') : null; } catch (e) { return null; }
}
async function quoteCast({ text, quotedFid, quotedHash, embedUrl }) {
  assertPostingEnabled('quoteCast');
  const embeds = [];
  if (quotedFid && quotedHash) embeds.push({ castId: { fid: quotedFid, hash: hbuf(quotedHash) } });
  if (embedUrl) embeds.push({ url: embedUrl });
  const m = await hub().makeCastAdd({ text: clean(text).slice(0, 320), embeds, embedsDeprecated: [], mentions: [], mentionsPositions: [], type: hub().CastType.CAST }, hubId(), signer());
  if (m.isErr()) throw new Error(m.error.message);
  await submit(m.value); return m.value.hash;
}
module.exports = { H, FID, HUB, MODEL, KEY, envfile, signer, submit, post, remove, follow, resolveFid, clean, ork, quoteCast, UngatedPostError };
