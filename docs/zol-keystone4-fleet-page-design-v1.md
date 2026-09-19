# ZOL Keystone 4: zaalcaster Fleet Page — Design v1

**Status**: Design-only. Implementation blocked on ZOL PRs #26-#39 merged + Pi activation.
**Depends on**: ZOL AgentGateway (PR #32/33), Keystone 3 Supabase bus (PR #40 design).
**Board task**: f7775231
**Author**: ZOL Persistent Agent loop, 2026-07-17

---

## Summary

Add a `/fleet` status page to `bettercallzaal/zaalcaster` showing live read-only status of
the ZOL v2 agent running on the Pi. The page displays ZOL agent health, active capsules,
recent DreamLoop activity, and the last 10 receipts.

The core challenge is connectivity: zaalcaster runs on Vercel (HTTPS, serverless) while ZOL
runs on the Pi (localhost:PORT, LAN-only). A direct Vercel-to-Pi HTTP call is not feasible.
This document specifies Option A (Supabase state relay, recommended) and Option B
(CloudFlare Tunnel).

---

## Requirements (from board task f7775231)

- Show ZOL agent health (sourced from AgentGateway `/health`)
- Show active capsules (from `/capsules`)
- Show DreamLoop status (from `/dreamloops`)
- Show last 10 receipts (from `/receipts`)
- Read-only — no write actions on the fleet page
- Must not expose Pi's local address or any secrets to the Vercel runtime

---

## Connection Model

### Option A — Supabase fleet_state relay (recommended)

ZOL writes its current status snapshot to a Supabase table on each `heartbeat` loop tick
(every ~5 min). zaalcaster reads from that table server-side via Supabase REST.

```
Pi / ZOL (heartbeat loop, every 5min)
  → POST /fleet_state upsert into Supabase
    {agent_id, health, capsules[], loops[], receipts[], updated_at}

Vercel / zaalcaster (api/fleet.js, on page load)
  → GET /rest/v1/fleet_state?agent_id=eq.zolbot&limit=1
  ← {health, capsules, loops, receipts, updated_at}
```

**Pros**: No Pi exposure. Survives Pi restarts gracefully (data ages, shows stale banner).
Consistent with Keystone 3 design (Supabase is already the ZOL-ZOE bus).

**Cons**: Data is ~5 min stale. Requires a new `fleet_state` Supabase table.

### Option B — CloudFlare Tunnel

ZOL runs `cloudflared tunnel` on the Pi, exposing AgentGateway at a stable
`https://zolbot.cfargotunnel.com` URL. zaalcaster calls it directly.

**Pros**: Live data.

**Cons**: New dependency (`cloudflared` daemon on Pi). Security surface (authenticated
transport required — AgentGateway already has API key auth, but Pi exposure is a new attack
surface). Out of scope for v1.

**Recommendation**: Ship Option A. Add Option B to a future improvement proposal once
the fleet is stable post-merge.

---

## ZOL-Side Changes (heartbeat loop + new handler)

### 1. `fleet-state-write` handler (`src/handlers/index.js`)

New handler key: `fleet.state.write`

```js
// fleet.state.write — called at end of heartbeat loop
// Upserts ZOL's current snapshot to Supabase fleet_state table.
// Fails silently (board outage must not block heartbeat).
async 'fleet.state.write'({ store, capsuleRegistry, dreamloopRegistry, receiptJournal }) {
  const health = {
    status: 'ok',
    uptime_s: process.uptime(),
    node_version: process.version,
    checked_at: new Date().toISOString(),
  };
  const capsules = await capsuleRegistry.list({ status: 'active' });
  const loops = await dreamloopRegistry.list({ status: ['live', 'dry-run'] });
  const receipts = await receiptJournal.list({ limit: 10 });

  const snapshot = {
    agent_id: 'zolbot',
    health: JSON.stringify(health),
    capsules: JSON.stringify(capsules.map(c => ({ id: c.id, version: c.version, status: c.status }))),
    loops: JSON.stringify(loops.map(l => ({ id: l.id, status: l.lifecycle_state, last_run: l.last_run }))),
    receipts: JSON.stringify(receipts.map(r => ({
      id: r.receiptId,
      loop: r.loopId,
      status: r.status,
      ts: r.completedAt,
    }))),
    updated_at: new Date().toISOString(),
  };

  try {
    const { COWORK_TRACKER_URL, COWORK_TRACKER_KEY } = process.env;
    if (!COWORK_TRACKER_URL || !COWORK_TRACKER_KEY) return { ok: false, reason: 'no-env' };
    const url = `${COWORK_TRACKER_URL}/rest/v1/fleet_state`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        apikey: COWORK_TRACKER_KEY,
        Authorization: `Bearer ${COWORK_TRACKER_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates',
      },
      body: JSON.stringify(snapshot),
    });
    return { ok: res.ok };
  } catch (e) {
    return { ok: false, error: e.message };
  }
},
```

### 2. `heartbeat` loop step addition (`loops/heartbeat.json`)

Add `fleet.state.write` as the last step in the heartbeat loop (after health checks pass):

```json
{
  "id": "fleet-state-write",
  "handler": "fleet.state.write",
  "description": "Upsert ZOL status snapshot to Supabase fleet_state table for zaalcaster fleet page",
  "on_error": "log_and_continue"
}
```

### 3. Supabase table: `fleet_state`

```sql
create table if not exists fleet_state (
  agent_id    text primary key,
  health      jsonb,
  capsules    jsonb,
  loops       jsonb,
  receipts    jsonb,
  updated_at  timestamptz not null default now()
);

-- RLS: service_role write (ZOL), anon read (zaalcaster)
alter table fleet_state enable row level security;
create policy "zolbot write" on fleet_state
  for all using (auth.role() = 'service_role');
create policy "public read" on fleet_state
  for select using (true);
```

Migration: `zaal` runs this SQL in Supabase dashboard before Pi activation.

---

## zaalcaster-Side Changes

### 1. `api/fleet.js` — new serverless function

```js
// api/fleet.js - Fleet page data endpoint (read-only, no auth required)
// Returns ZOL agent snapshot from Supabase fleet_state table.
import { createClient } from '@supabase/supabase-js';

const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY,
);

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).end();

  const { data, error } = await sb
    .from('fleet_state')
    .select('*')
    .eq('agent_id', 'zolbot')
    .single();

  if (error || !data) {
    return res.status(200).json({ ok: false, reason: error?.message ?? 'no-data' });
  }

  const staleSec = (Date.now() - new Date(data.updated_at).getTime()) / 1000;
  return res.status(200).json({
    ok: true,
    stale: staleSec > 600,           // warn if > 10 min old
    stale_sec: Math.round(staleSec),
    health: JSON.parse(data.health ?? '{}'),
    capsules: JSON.parse(data.capsules ?? '[]'),
    loops: JSON.parse(data.loops ?? '[]'),
    receipts: JSON.parse(data.receipts ?? '[]'),
    updated_at: data.updated_at,
  });
}
```

### 2. Fleet tab in `public/index.html`

Add tab key `f` (or `0`) for the Fleet tab, visible to Zaal-role only (matches Empire tab pattern, key 8):

```js
// Tab registration (alongside Empire tab key 8)
if (key === 'f') showTab('fleet');

// Fleet tab HTML structure
<div id="tab-fleet" class="tab hidden">
  <div id="fleet-status"></div>
</div>

// Fleet tab renderer
async function renderFleet() {
  const el = document.getElementById('fleet-status');
  el.textContent = 'loading...';
  const r = await fetch('/api/fleet');
  const d = await r.json();
  if (!d.ok) { el.textContent = 'ZOL offline or unreachable.'; return; }

  const staleBanner = d.stale
    ? `<p class="warn">Data is ${Math.round(d.stale_sec / 60)} min stale.</p>`
    : '';

  el.innerHTML = `
    ${staleBanner}
    <h2>ZOL Agent Health</h2>
    <p>Status: ${d.health.status} | Uptime: ${Math.round((d.health.uptime_s ?? 0) / 3600)}h</p>
    <p>Updated: ${new Date(d.updated_at).toLocaleString()}</p>

    <h2>Active Capsules (${d.capsules.length})</h2>
    <ul>${d.capsules.map(c => `<li>${c.id} v${c.version} [${c.status}]</li>`).join('')}</ul>

    <h2>DreamLoops (${d.loops.length})</h2>
    <ul>${d.loops.map(l => `<li>${l.id} [${l.status}]${l.last_run ? ' — ' + new Date(l.last_run).toLocaleString() : ''}</li>`).join('')}</ul>

    <h2>Recent Receipts</h2>
    <table>
      <tr><th>Loop</th><th>Status</th><th>Time</th></tr>
      ${d.receipts.map(r => `<tr><td>${r.loop}</td><td>${r.status}</td><td>${new Date(r.ts).toLocaleString()}</td></tr>`).join('')}
    </table>
  `;
}
```

### 3. Config constant for product name

Per task requirement "name as config constant":

```js
// In zaalcaster/config.js (add alongside existing constants)
export const FLEET_AGENT_ID = process.env.FLEET_AGENT_ID ?? 'zolbot';
export const FLEET_PRODUCT_NAME = process.env.FLEET_PRODUCT_NAME ?? 'ZOL';
```

Use `FLEET_PRODUCT_NAME` in the Fleet tab heading so it can be white-labeled without code edits.

### 4. Vercel env vars to add

| Variable | Value |
|----------|-------|
| `SUPABASE_URL` | Same Supabase project as ZOL (COWORK_TRACKER_URL without `/rest/v1`) |
| `SUPABASE_ANON_KEY` | Supabase anon key (public-safe) |
| `FLEET_AGENT_ID` | `zolbot` (optional, default hardcoded) |
| `FLEET_PRODUCT_NAME` | `ZOL` (optional, for white-labeling) |

`SUPABASE_ANON_KEY` is public-safe per Supabase RLS design — the fleet_state policy allows anon reads.

---

## Security Invariants

- No Pi address, Pi credentials, or ZOL secrets appear in zaalcaster's Vercel env.
- The Supabase anon key used by zaalcaster is read-only by RLS policy.
- ZOL writes to fleet_state using the service_role key (COWORK_TRACKER_KEY already in Pi env).
- No wallet, signer, or token data is included in the fleet_state snapshot.
- The fleet page is Zaal-role-only in zaalcaster (same `blockedByAuth` guard as Empire tab).
- Receipts in the snapshot contain only: receiptId, loopId, status, completedAt. No model outputs, no prompts, no memory contents.

---

## Implementation Sequence

This is blocked until ZOL PRs #26-#39 merge and the Pi is activated. After that:

1. **Zaal**: Run the `fleet_state` SQL migration in Supabase dashboard.
2. **ZOL loop**: Add `fleet.state.write` handler + heartbeat step + verify locally.
3. **zaalcaster**: Open a PR adding `api/fleet.js` + Fleet tab in `public/index.html` + config constants.
4. **Zaal**: Set `SUPABASE_URL` + `SUPABASE_ANON_KEY` in Vercel env.
5. **Verify**: Heartbeat runs → Supabase row appears → Fleet tab shows live data.
6. **Edge case**: Pi restarts → stale banner shows within 10 min → recovers on next heartbeat.

Estimated implementation effort (post-merge): 2-3h for ZOL handler + heartbeat update + zaalcaster PR.

---

## Open Questions

1. **Supabase RLS after cowork-rls-hardening.sql (PR #1279)**: The existing hardening drops
   `authenticated_all` policies. Does the fleet_state anon-read policy conflict with anything
   in the new RLS setup? (Zaal to verify before running the migration.)

2. **Supabase project**: Should fleet_state share the same project as ZAOcowork tracker
   (COWORK_TRACKER_URL) or a separate one? Sharing is simpler but couples ZOL's fleet
   visibility to the cowork service. Using the same project is recommended for v1.

3. **Heartbeat frequency**: Current heartbeat cooldown is defined in `loops/heartbeat.json`.
   Is 5-min stale acceptable for the fleet page, or should fleet_state be written on a
   separate faster ticker? (5-min is recommended for v1 — aligns with heartbeat, no new timer.)

4. **Receipt content depth**: Are receiptId + loopId + status + timestamp sufficient for the
   fleet page, or does Zaal want the full evidence field (artifact hashes, tool call counts)?
   Keep receipts lightweight for v1; add depth if Zaal requests.
