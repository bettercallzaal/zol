// zol-drain.js - drain Zaal-approved casts from the cowork tracker and cast via @zolbot.
// DRY-RUN by default: logs what it WOULD cast + marks the row, but does NOT post.
// Set ZOL_DRAIN_LIVE=1 to actually cast (each row was already Approved by Zaal in ZOE).
// Run from ~/zol/farcaster-agent. Cron/loop it. Reads creds from ~/.zao/private/zol-drain.env.
const fs = require('fs');
const H = process.env.HOME;

function envval(env, k) {
  const m = env.match(new RegExp('^' + k + '=(.*)$', 'm'));
  return m ? m[1].replace(/^"|"$/g, '').trim() : '';
}

(async () => {
  const env = fs.readFileSync(H + '/.zao/private/zol-drain.env', 'utf8');
  const BASE = envval(env, 'COWORK_TRACKER_URL').replace(/\/$/, '');
  const KEY = envval(env, 'COWORK_TRACKER_KEY');
  const LIVE = process.env.ZOL_DRAIN_LIVE === '1';
  if (!BASE || !KEY) { console.error('zol-drain: no tracker creds'); process.exit(1); }
  const HDR = { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' };

  const url = BASE + '/rest/v1/tasks?legacy_source=like.zolcast:*&status=eq.todo&select=id,title,legacy_source&order=created_at.asc&limit=10';
  const res = await fetch(url, { headers: HDR });
  if (!res.ok) { console.error('zol-drain: tracker fetch failed', res.status); process.exit(1); }
  const rows = await res.json();
  if (!Array.isArray(rows) || rows.length === 0) { console.log('zol-drain: nothing queued (' + (LIVE ? 'LIVE' : 'DRY-RUN') + ')'); return; }

  const L = LIVE ? require('../src/zol-lib') : null;
  for (const row of rows) {
    const text = row.title;
    try {
      if (LIVE) {
        await L.post({ text });
        console.log('CAST: ' + String(text).slice(0, 100));
      } else {
        console.log('[DRY-RUN] would cast: ' + String(text).slice(0, 140));
      }
      await fetch(BASE + '/rest/v1/tasks?id=eq.' + encodeURIComponent(row.id), {
        method: 'PATCH',
        headers: { ...HDR, Prefer: 'return=minimal' },
        body: JSON.stringify({ status: 'done', notes: (LIVE ? 'zol-cast ' : 'zol-dryrun ') + new Date().toISOString() }),
      });
    } catch (e) {
      console.error('zol-drain err for ' + row.id + ':', (e && e.message) || e);
    }
  }
})().catch((e) => { console.error('ERR', (e && e.message) || e); process.exit(1); });
