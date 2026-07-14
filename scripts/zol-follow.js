// zol-follow.js - daily batch: ZOL follows accounts Zaal (@zaal, FID 19640)
// already follows, up to a daily cap. FREE: a follow is a Farcaster Link
// message, self-signed and submitted via the same api-key hub path as a cast
// - no wallet, no x402, no spend. Reads are haatz (free mirror), same as the
// rest of ZOL. Cron: once/day. Test without following: ZOL_DRY=1 node scripts/zol-follow.js
const fs = require('fs');
const L = require('../src/zol-lib');
const H = process.env.HOME;
const HAATZ = 'https://haatz.quilibrium.com';
const ZAAL_FID = 19640;
const DAILY_CAP = parseInt(process.env.FOLLOW_DAILY_CAP || '20');
const DRY = process.env.ZOL_DRY === '1';
const LOG_PATH = H + '/zol/follow-log.json';

const tg = L.envfile(H + '/.zao/private/tg.env');
const TG_TOKEN = tg.ZOE_BOT_TOKEN || tg.TG_TOKEN || '';
const TG_CHAT = tg.ZAAL_TELEGRAM_ID || tg.TG_CHAT || '';

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
async function ping(msg) { if (!TG_TOKEN || !TG_CHAT) return; try { await fetch('https://api.telegram.org/bot' + TG_TOKEN + '/sendMessage', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: TG_CHAT, text: msg }) }); } catch (e) {} }
async function gj(u) { for (let i = 0; i < 3; i++) { try { const r = await fetch(u, { signal: AbortSignal.timeout(15000) }); if (r.ok) return await r.json(); } catch (e) {} await sleep(800); } return null; }

async function followSet(fid) {
  const s = new Set();
  const j = await gj(`${HAATZ}/v1/linksByFid?fid=${fid}&link_type=follow&pageSize=1000`);
  if (j && j.messages) for (const m of j.messages) { const t = m.data?.linkBody?.targetFid; if (t) s.add(t); }
  return s;
}
async function uname(fid) {
  const j = await gj(`${HAATZ}/v1/userDataByFid?fid=${fid}`);
  if (!j || !j.messages) return null;
  const m = j.messages.find((m) => m.data?.userDataBody?.type === 'USER_DATA_TYPE_USERNAME');
  return m ? m.data.userDataBody.value : null;
}
function appendLog(entries) {
  let a = [];
  try { a = JSON.parse(fs.readFileSync(LOG_PATH, 'utf8')); } catch (e) {}
  a.push({ ts: new Date().toISOString(), entries });
  try { fs.writeFileSync(LOG_PATH, JSON.stringify(a.slice(-90), null, 2)); } catch (e) {}
}

(async () => {
  try {
    const [zaalFollows, zolFollows] = await Promise.all([followSet(ZAAL_FID), followSet(L.FID)]);
    const candidates = [...zaalFollows].filter((f) => !zolFollows.has(f) && f !== L.FID).slice(0, DAILY_CAP);

    if (candidates.length === 0) {
      console.log('ZOL: no new accounts to follow today (already following everyone in range, or caught up to @zaal\'s list)');
      return;
    }

    const results = [];
    for (const fid of candidates) {
      const h = await uname(fid) || ('fid:' + fid);
      if (DRY) {
        console.log(`[DRY] would follow @${h} (fid ${fid})`);
        results.push({ fid, username: h, ok: true, dry: true });
        continue;
      }
      try {
        await L.follow(fid);
        results.push({ fid, username: h, ok: true });
        console.log(`followed @${h} (fid ${fid})`);
      } catch (e) {
        results.push({ fid, username: h, ok: false, error: (e && e.message || e).toString().slice(0, 120) });
        console.log(`FAILED @${h}: ${(e && e.message) || e}`);
      }
      await sleep(2000 + Math.random() * 3000); // spread writes out, don't hammer the hub
    }

    appendLog(results);
    const ok = results.filter((r) => r.ok).length;
    const names = results.filter((r) => r.ok).map((r) => '@' + r.username).join(', ');
    await ping(`ZOL followed ${ok}/${results.length} today (mirroring @zaal's follows)${DRY ? ' [DRY RUN]' : ''}:\n${names}`);
    console.log(`done: ${ok}/${results.length} followed`);
  } catch (e) {
    await ping('ZOL follow batch failed: ' + ((e && e.message) || e));
    console.error('ERR', (e && e.message) || e);
    process.exit(1);
  }
})();
