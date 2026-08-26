# ZOL Revival

Phase 1 audit, read-only. Written 2026-08-25 from branch `ws/dreamloop-artist-spotlight`
at `f656eb6`. No credentials were read for their values, nothing was deployed, nothing
was pushed.

Goal this document serves: Zaal tags @zolbot on Farcaster, and ZOL learns about the
thing he tagged.

---

## 1. What ZOL is

`@zolbot`, Farcaster FID **3338501**. A music scout for The ZAO, COC Concertz, WaveWarZ
and ZABAL Gamez. Node.js 18+, CommonJS, no framework. It signs its own Farcaster
messages with a local Ed25519 signer key and submits them to a hub. Drafting is an
OpenRouter call. Posting is human-gated by default, with named auto-post carve-outs.

Three moving parts:

| Layer | What it uses | Key needed |
|---|---|---|
| Reads (discovery, mentions) | `haatz.quilibrium.com` HTTP hub mirror | none |
| Drafting | OpenRouter, `anthropic/claude-fable-5` primary | OpenRouter key |
| Signing and submit | `@farcaster/hub-nodejs` -> `hub-api.neynar.com/v1/submitMessage` | Neynar API key + signer key |
| Operator gate | Telegram (ZOE bot) -> `post-reply.js` | Telegram bot token + Zaal chat id |

There is a second, newer layer grafted on top: **DreamLoops**, a capsule/manifest
persistent-agent runtime (`capsules/`, `loops/`, `src/handlers/`, `src/state-adapter.js`,
`scripts/dl-*.js`). It is fully inert. Every loop is gated behind `DREAMLOOPS_ENABLED`
plus a per-loop flag, and neither has ever been set on the Pi. DreamLoops is not on the
critical path for tag-and-learn, but it is where durable memory should eventually live
(see phase 2).

---

## 2. Current state, measured not assumed

ZOL is **not dead. It is half-alive, and the half that is dead is the half you notice.**

Pulled live from the haatz mirror during this audit:

- **Last root cast (the daily curator cast): 2026-08-03 16:00 UTC.** Silent for 22 days.
- **Last reply cast: 2026-08-22 15:35 UTC.** Three days ago.
- Of ZOL's last 60 casts: 32 roots, 28 replies.

So something on the Pi is still running and still holds a working signer key, a working
Neynar key and a working OpenRouter key as of three days ago. The replies are coming from
`scripts/zol-zabal-watch.js`, which is the one daemon that calls `zol-lib.post()`
directly with no draft gate. The daily curator cast, which runs through the gated
`zol-daily.js` path, stopped three weeks ago.

**Mentions of ZOL that were never answered:**

| When | From | Gist |
|---|---|---|
| 2026-07-12 | fid 19640 (Zaal) | find the zabalgamez recording links for empire builder |
| 2026-07-19 | fid 19640 (Zaal) | wants to tip people on the timeline by tagging ZOL |
| 2026-08-03 | fid 19640 (Zaal) | how can I make ZOL better at interacting with other accounts |
| 2026-08-03 | fid 19640 (Zaal) | can u do any of that |

ZOL has replied to Zaal exactly **once, ever**: 2026-07-13, "Got it. Locked that in." That
was `zol-threads.js` acking feedback on ZOL's own cast, not an answer to a tag.

---

## 3. Why the tags do nothing

Three separate faults. They are independent and the first one is the whole ballgame.

### Fault 1 - ZOL is hardcoded to ignore Zaal. This is the blocker.

`scripts/zol-reply.js:52`

```js
if(pfid===19640){continue;} // skip owner's own casts - ZOL does not reply to Zaal announcements
```

FID 19640 is Zaal. The mention daemon drops every cast he tags it in, before drafting,
before staging, before the Telegram ping. Introduced 2026-07-13 in `8525946` (the repo
scaffold commit) to stop ZOL replying to Zaal's launch announcements. The side effect is
that the exact interaction now being asked for is filtered out at ingestion.

Nothing else is wrong with the mention path. It polls
`haatz.quilibrium.com/v1/castsByMention?fid=3338501` every 300s, dedupes against
`~/zol/.reply-seen`, drafts, writes `~/zol/drafts/<hash>.json`, and pings Telegram with a
one-line approve command. Verified live during this audit: that endpoint returns HTTP 200
and 12 mentions, so the read path is healthy and needs no API key.

### Fault 2 - the daily cast died silently, and the alarm was trained away

Fixed locally today in `3521015`, **not yet pushed**. Drafting called a single OpenRouter
model and threw a bare "no draft from model" on any empty completion, so one model out of
credits or rate limited silenced the cast with no usable reason. The failure ping had no
throttle, so a persistent outage pinged hourly until the channel became noise. The fix
walks a model ladder (primary, then `deepseek/deepseek-chat`, then
`meta-llama/llama-3.3-70b-instruct`), captures each rung's real error text, and throttles
repeat failures to one ping per 6h via `~/zol/last-failure.json`.

This explains the 2026-08-03 stop. It does not explain the tags, and shipping it alone
will not make ZOL answer Zaal.

### Fault 3 - "learns about the tagged thing" does not exist yet

This is a build, not a repair. Grepping all of `scripts/` and `src/` for
`castAddBody.embeds` or `embeds[` returns **nothing**. ZOL reads a mention's `text` and
throws away its embeds. Tag it with a track link, a quoted cast, or an artist page and it
sees a sentence with a URL-shaped hole in it.

What exists that is close:

- `zol-reply.js` `logGraph()` writes the mention plus ZOL's draft to the ZABAL Bonfire
  knowledge graph as an episode. Write-only in practice; `recall()` reads back from
  `/delve` but the README records Bonfire reads as blocked pending admin labeling.
- `zol-threads.js` distills Zaal's feedback into an imperative rule and appends it to
  `~/zol/zol-persona.md`, which every script reads. That is real durable learning, but it
  only fires on replies to ZOL's own casts and only learns *style*, not *subjects*.
- `src/state-adapter.js` is a working three-backend key/value store with receipts
  (atomic file, sqlite WAL, Bonfire). `~/zol/state/` already exists on this mac. This is
  the right home for learned facts and it is already built and tested.

So the pieces are there. Nobody has wired "mention arrives -> resolve what it points at
-> write it down".

---

## 4. Where it ran, and whether it still does

- **Host**: Raspberry Pi, hostname `ansuz`, user `zaal`. Repo lives at
  `~/zol/farcaster-agent`, runtime state at `~/zol/`.
- **Scheduling as actually deployed**: cron plus three tmux daemons (`zol`, `zolt`,
  `zolz`) kept alive by `start-fleet.sh` every 15 minutes. The mention daemon
  `zol-reply.js` is the tmux session `zol`.
- **Dashboard**: `scripts/dashboard.js`, Express on port 8088, Tailscale-only, no public
  HTTPS.
- **Reachability from this mac right now**: `ansuz.lan` resolves to `192.168.40.79` but
  `ping` returns "No route to host", and `tailscale status` reports **Tailscale is
  stopped** on this machine. That is a local connectivity gap, not evidence the Pi is
  down. The 2026-08-22 casts say the Pi was alive three days ago.
- **The systemd kit is a decoy.** `deploy/` (units for `zol-daily`, `zol-reply`,
  `zol-calendar`, plus `migrate.sh`) is merged on origin and its own README says
  "build-only, never-tested kit" that "has never been executed against the actual Pi".
  Do not treat it as the deployment. The live deployment is still cron plus tmux.

---

## 5. Credentials and hosting Zaal needs to supply

Names only. No values were read, printed, or copied during this audit.

**On this mac, present** (`~/.zao/private/`):

| File | Vars |
|---|---|
| `neynar.env` | `NEYNAR_API_KEY` |
| `openrouter.key` | raw key, non-empty |
| `tg.env` | `ZOE_BOT_TOKEN`, `ZAAL_TELEGRAM_ID`, `ZAAL_BOTZ_GROUP_ID`, `ZAAL_BOTZ_CC_THREAD`, `QUESTIONS_TOPIC_ID` |
| `farcaster-zaal.env` | `NEYNAR_API_KEY`, `ZAAL_FID`, `ZAAL_SIGNER_UUID`, `KV_REST_API_URL`, `KV_REST_API_TOKEN` (this is Zaal's own signer, not ZOL's) |

**Missing on this mac, required to run ZOL anywhere but the Pi:**

1. `~/.openclaw/farcaster-credentials.json` - ZOL's Ed25519 signer private key plus fid.
   The directory `~/.openclaw` does not exist here. **This is the one thing that cannot
   be regenerated without an on-chain Key Registry transaction from the custody wallet**
   (`scripts/rotate.js`). Without it ZOL can read and draft but cannot post.
2. `~/.zao/private/bonfire.env` - `BONFIRE_API_KEY`, `BONFIRE_ID`. Absent here. Only
   affects the graph-recall and episode-logging paths, both of which fail closed.
3. `~/.zao/private/zol-drain.env` - `COWORK_TRACKER_URL`, `COWORK_TRACKER_KEY`. Absent
   here. Only affects the cowork bridge.

**Hosting decision Zaal owes:**

- Start Tailscale on this mac and confirm `ansuz` is up, or
- Say the Pi is gone, in which case ZOL needs a new host and the signer key has to be
  recovered from the Pi's disk or rotated on-chain.

That single answer decides whether phase 2 is a 20-minute patch or a migration.

---

## 6. Shortest path to ZOL answering an @tag

Assumes the Pi is reachable. Roughly one working session, one file, one flag.

1. **Delete the Zaal skip.** Replace `zol-reply.js:52` with an opt-in guard so ZOL still
   ignores broadcast announcements but always answers a direct tag. Cheapest correct
   version: only skip fid 19640 when the cast has no `parentCastId` **and** ZOL is one of
   several mentions, i.e. a broadcast. A direct reply or a solo tag goes through.
2. **Read the embeds.** In the mention loop, pull `m.data.castAddBody.embeds`. For each
   `url`, fetch and extract title plus text. For each `castId`, resolve it through
   haatz `castById`. Feed that into the draft prompt as context instead of dropping it.
   Bound it: 3 embeds max, 8s timeout each, 2KB of extracted text each, failures skipped
   silently.
3. **Write down what it learned.** Persist `{mention hash, from fid, text, resolved
   embeds, draft, timestamp}` through the existing `createStateStore()` in
   `src/state-adapter.js`, atomic-file backend, under `~/zol/state/`. No new dependency,
   no Bonfire requirement, and it survives a restart. Keep the existing `logGraph()`
   Bonfire write as a best-effort second sink.
4. **Deploy the way the Pi actually works.** `git pull` in `~/zol/farcaster-agent`, then
   `tmux kill-session -t zol` and let `start-fleet.sh` bring it back within 15 minutes.
   Do not run `deploy/migrate.sh`.
5. **Ship the failover fix with it.** `3521015` is sitting unpushed on this branch and
   directly addresses why the daily cast has been silent since 2026-08-03.
6. **Test in the open.** Zaal tags @zolbot with a link. Expected: Telegram ping within
   5 minutes carrying the draft plus the `post-reply.js <hash>` command, and a new entry
   under `~/zol/state/`. Approval stays manual for the first several.

What stays untouched: the approval gate, the bot blocklist, the double-tag guard, the
`@`-stripping on output, and the no-spend guarantee. Step 1 widens who ZOL listens to. It
does not widen what ZOL can do.

---

## 7. Phase 2 plan

**2a. Land tag-and-learn** - the six steps in section 6. Definition of done: Zaal tags
ZOL with a track link, gets a Telegram draft that demonstrably references the linked
thing, approves it, and the fact persists across a daemon restart.

**2b. Answer the four unanswered tags by hand.** The 2026-07-12 zabalgamez recording
links, 2026-07-19 tipping, and both 2026-08-03 questions. They are the first real test
corpus and two of them are direct feature requests from the operator.

**2c. Confirm the whole fleet, not just the loud part.** The 2026-08-03 daily stop went
unnoticed for three weeks because zabal-watch kept posting and made ZOL look alive.
Needs a liveness check per script, reported into Telegram, that fires on absence rather
than on error.

**2d. Decide the tipping ask, separately and explicitly.** Zaal's 2026-07-19 tag asks for
tipping by tag. The 2026-07-16 handoff records four Bankr scoping questions that were
posed and never answered, and every capsule in this repo carries "no signer access, no
fund movement" as its core safety guarantee. Do not let this ride in on the back of
tag-and-learn. It is a different risk class and needs its own decision.

**2e. Then, and only then, DreamLoops.** Flip `DREAMLOOPS_ENABLED` plus per-loop flags
for `weekly-curator-v1` and `artist-spotlight-v1`, and move learned facts from the flat
state store into capsule state. Both loops are merged, tested and inert. They are an
upgrade to a working ZOL, not a way to get one.

**2f. Housekeeping, on Zaal's word only.** See section 8.

---

## 8. Repo state, and one thing that needs a decision

This working tree has 13 files in `AD` state (staged as added, then deleted from disk).
Per the 2026-07-16 handoff at
`.handoffs/session-2026-07-16-zol-dreamloops-bankr-hold/README.md`, this is the residue of
an agent that was launched with worktree isolation and ran its git operations in the
shared directory anyway. Two `git reset --hard` attempts were denied in that session, and
that denial has been treated as standing since.

Preserved before this audit touched anything, both recoverable without a reset:

- Full file copies at
  `<scratchpad>/index-backup/` (211 files).
- A GC-proof snapshot commit at ref `refs/backup/index-snapshot-2026-08-25`
  (`c1fe4f3c658c997ba9679424d7f7b3ee19abeb05`).

All 13 blobs were verified present in the object store. Their content is also already
merged on `origin/main` via PRs #20, #21 and #12.

**Unpushed local work that is genuinely unique**, contrary to what the July handoff
concluded, because it landed today:

- `3521015` zol-daily model failover and failure-ping throttle
- `1e65d08` agent config
- `f656eb6` the handoff bundle

`origin/main` has also moved ahead to `8b3339a`, beyond the `6199a72` this branch's
remote ref knows about, and a new remote branch
`feat/activate-weekly-curator-artist-spotlight` exists. Reconcile before any push.

Recommendation: land the section 6 change, push `3521015` with it, and clean the `AD`
state afterwards on Zaal's explicit go-ahead. Not before.
