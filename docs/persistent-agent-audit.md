# ZOL Phase 0 - Persistent-Agent Audit (Pre-DreamLoops Graft)

**Date**: 2026-07-14  
**Status**: AUDIT ONLY - no code changes, no dependencies vendored, no deployment  
**Target**: Ground the DreamLoops graft in the actual ZOL codebase, not assumptions  
**DreamLoops Reference**: github.com/BrandonDucar/dreamloops commit 1c6d3b1910f5b83639e0735634740902e2caacff

---

## 1. CURRENT BEHAVIOR (What ZOL Actually Does Today)

### 1.1 Posting Lanes

ZOL (@zolbot, FID 3338501) is a music-curator Farcaster agent running on Raspberry Pi (ansuz) with three posting modalities:

#### A. Auto-Post (No Approval Gate)
- **zol-daily.js** (cron: hourly 0-23 UTC)  
  - Polls Bonfire `/delve` for ZAO context (src/zol-lib.js:74-80, scripts/zol-daily.js:74-80)
  - Drafts via OpenRouter claude-fable-5 (45s timeout, ~$0.001 per draft, scripts/zol-daily.js:86-88)
  - Anti-spam: similarity guard (50% word overlap rejection) + hourly recall rotation + 0-40min jitter delay (scripts/zol-daily.js:61-72, 131-133)
  - Stores recent casts to `~/zol/recent-casts.json` (max 24 casts, scripts/zol-daily.js:21-22, 50-56)
  - Posts immediately if fresh + passes guards
  - Logs episode to Bonfire (scripts/zol-daily.js:106-110)
  - Pings Zaal on Telegram with result (scripts/zol-daily.js:139, 142)
  - Writes last-posted to `~/zol/drafts/last-posted.json` (scripts/zol-daily.js:137-138)

- **zol-follow.js** (cron: daily 15:00 UTC, PRs #1 + #2)  
  - Follows up to 20 accounts that @zaal already follows but ZOL doesn't
  - Uses same signer + Neynar API path as posts (no wallet, no spend)
  - Auto-posts, no approval gate
  - Telegram summary after each run

#### B. Gated (Approval Required via Telegram -> Dashboard/CLI)
- **zol-reply.js daemon** (tmux session: zol, keeps-alive via start-fleet.sh every 15min)  
  - Polls haatz.quilibrium.com every 5min for @zolbot mentions (scripts/zol-reply.js:42)
  - Tracks seen mentions in `~/.reply-seen` (append-only, line per hash, scripts/zol-reply.js:22, 46)
  - Drafts reply via OpenRouter (40s timeout, scripts/zol-reply.js:28-34)
  - Stores draft to `~/zol/drafts/<hash>.json` with parentFid + parentHash (scripts/zol-reply.js:54)
  - Pings Zaal on Telegram with draft + SSH command: `node post-reply.js <hash>` (scripts/zol-reply.js:56)
  - Zaal approves via dashboard (http://ansuz:8088 on Tailscale) or CLI (scripts/dashboard.js)
  - Human invokes `post-reply.js <hash>` which posts the staged draft and renames to `.posted` (scripts/post-reply.js:1-31)
  - Retries failed fetches with exponential backoff (fails counter, scripts/zol-reply.js:61)
  - Reads persona from `~/zol/zol-persona.md` (scripts/zol-reply.js:18)

- **zol-threads.js daemon** (tmux session: zolt, keeps-alive via start-fleet.sh)  
  - Watches REPLIES to ZOL's own casts via Neynar notifications API (scripts/zol-threads.js:~75)
  - If reply from @zaal (FID 19640): extracts feedback via OpenRouter, appends to `zol-persona.md`, auto-replies ack (scripts/zol-threads.js:~120-130)
  - If reply from others: drafts reply, stages to `~/zol/drafts/`, pings Zaal for approval
  - Tracks seen notifications in `~/.threads-seen` (scripts/zol-threads.js:~65)

- **zol-learn-zaal.js daemon** (tmux session: zolz, keeps-alive via start-fleet.sh)  
  - Watches @zaal's Farcaster posts via Neynar API
  - Extracts signals, quotes every 4th strong post with ZOL thoughts
  - Can be gated via ZOL_QUOTECAST_DRAFT env var (defaults auto if unset, README.md:159)

- **zol-calendar.js** (cron: every 15min, PR #11 - awaiting merge)  
  - Polls ZAO Luma calendar ICS feed (CALENDAR_ICS_URL env var, default cal-jPH4al7AMlXzdNN)
  - Tracks event moments ("new" / "day-before" / "morning-of") in `~/zol/calendar-state.json` (src/calendar-moments.js:12-26)
  - Drafts calendar event casts via OpenRouter
  - Stages drafts to `~/zol/drafts/event-<id>.json` (scripts/zol-calendar.js, PR #11)
  - Pings Zaal for approval (no auto-post, gated like mentions)
  - Collapses multiple due moments into one cast (most time-urgent framing wins, src/calendar-moments.js:26)

#### C. Research-Only (No Posting)
- **overnight.js** (cron: @reboot + every 15min, capped by MAX_RUNTIME_H env var)  
  - Discovers trending Base/AI-agent casts via haatz
  - Extracts themes via keyword frequency
  - Drafts 5 cast ideas via OpenRouter (with heuristic fallback if key missing)
  - Writes report to `~/zol/overnight_report.md` (append-only log + final report)
  - Returns null if any casting call fails (graceful degradation, scripts/overnight.js:~30-80)
  - No wallet, no signer, read-only research only

### 1.2 Approval Flow (Telegram -> Dashboard -> Post)

1. Daemon or cron drafts content
2. Stages to `~/zol/drafts/<id>.json` with metadata (text, parentFid/parentHash for replies, or uid/moment/summary for calendar)
3. Sends Telegram to Zaal with draft + one-liner approval command
4. Zaal either:
   - Opens http://ansuz:8088 dashboard (Express.js, scripts/dashboard.js:1-36), sees pending drafts, clicks "Post"
   - Or SSH's directly: `node post-reply.js <hash>` or `node post-event.js <id>`
5. Posting script reads staged draft, signs with local Ed25519 key, submits to Neynar hub
6. Moves draft file from `.json` to `.json.posted` (scripts/post-reply.js:29)

### 1.3 Daemons (Keep-Alive via start-fleet.sh)

Per README.md:149-159, three tmux sessions auto-restarted by `start-fleet.sh` (cron + @reboot):
- `tmux new-session -d -s zol 'node scripts/zol-reply.js'` 
- `tmux new-session -d -s zolt 'node scripts/zol-threads.js'`
- `tmux new-session -d -s zolz 'node scripts/zol-learn-zaal.js'`

Each daemon runs an infinite loop with exponential backoff on errors.  
Restart: `tmux kill-session -t <zol|zolt|zolz>` → start-fleet.sh notices within 15min or manual restart.

### 1.4 Signer & Identity

- **Farcaster identity**: FID 3338501 (hardcoded in scripts)
- **Signer key**: Ed25519, stored in `~/.openclaw/farcaster-credentials.json` (signerPrivateKey field, JSON)
- **Custody wallet**: Separate key on Pi only (rotate.js + src/add-signer.js), never in repo, used only for Key Registry operations
- **API signing**: All posts self-signed locally, submitted to Neynar hub with API key auth (free tier, no x402 payment)
- **Safety**: No wallet spend capability, no launch signing, no transaction signing

### 1.5 State Files & Persistence Across Restarts

| File | Purpose | Format | Persistence Mechanism |
|------|---------|--------|----------------------|
| `~/.reply-seen` | Mentions daemon seen-set | Lines (hash per line) | Append-only, seeded on first run |
| `~/.threads-seen` | Threads daemon seen-set | Lines (hash per line) | Append-only, seeded on first run |
| `~/zol/recent-casts.json` | Anti-spam for zol-daily | JSON array of {text, ts} | Rotate to keep last 24 |
| `~/zol/calendar-state.json` | Calendar moments tracking | JSON {knownUids[], drafted{}} | RW after each poll (PR #11) |
| `~/zol/zol-persona.md` | Voice rules + learned feedback | Markdown | Append new learned rules, read on every draft |
| `~/zol/zol-persona.md` | Learned feedback from Zaal | Markdown section | Appended by zol-threads.js when Zaal replies |
| `~/zol/bot-blocklist.json` | FIDs to skip | JSON {fids:[]} | Editable by hand, fallback hardcoded |
| `~/zol/overnight_report.md` | Research report (append-only log) | Markdown | Append log lines, final sections |
| `~/zol/drafts/*.json` | Staged replies, calendar events | JSON {text, parentFid, parentHash, ...} | Written by daemon, moved to `.posted` on approval |
| `~/zol/drafts/*.posted` | Posted draft archive | (same as `.json`) | Renamed from `.json` after posting |
| `~/zol/drafts/last-posted.json` | Last auto-posted curator cast | JSON {text, posted: ISO8601} | Overwritten by zol-daily after each post |

**No database.** All state is file-based: JSON, Markdown, append-only logs.

### 1.6 Environment Variables (All Read from Files on Pi)

| Var | Source File | Script(s) | Notes |
|-----|-------------|----------|-------|
| `NEYNAR_API_KEY` | `~/.zao/private/neynar.env` | All posting scripts | Free tier, hub reads + user lookups |
| `OPENROUTER_MODEL` | env default | zol-daily, zol-reply, zol-threads, overnight | `anthropic/claude-fable-5` by default |
| OpenRouter key | `~/.zao/private/openrouter.key` | zol-lib.js, all drafting scripts | Raw key file (no KEY=VALUE) |
| `ZOE_BOT_TOKEN`, `ZAAL_TELEGRAM_ID` | `~/.zao/private/tg.env` | All daemons + cron jobs | Telegram approval gate |
| `BONFIRE_API_KEY`, `BONFIRE_ID` | `~/.zao/private/bonfire.env` | zol-daily.js, zol-reply.js | Context recall + episode logging |
| `COWORK_TRACKER_URL`, `COWORK_TRACKER_KEY` | `~/.zao/private/zol-drain.env` | zol-drain.js | Cowork tracker bridge (separate daemon) |
| `CALENDAR_ICS_URL`, `CALENDAR_LOOKAHEAD_DAYS` | env defaults | zol-calendar.js (PR #11) | ICS feed polling |
| Runtime flags | env inline by cron | Various | `ZOL_DRY=1`, `ZOL_QUOTECAST_DRAFT=1`, `MAX_RUNTIME_H=`, `FOLLOW_DAILY_CAP=` |

**Secrets policy**: No `.env` file in repo. Secrets read from fixed Pi paths only (`.zao/private/`, `.openclaw/`).  
**Secret scanning**: `scripts/secret-scan.sh` blocks 64-hex, `sk-`-shaped keys, PEM blocks (run before every commit).

---

## 2. WHAT ALREADY EXISTS Toward Persistence

ZOL is **not a bare-bones script**. It already has significant durable-agent scaffolding:

### 2.1 State Management (Durable Across Restarts)

1. **Seen-sets for deduplication** (scripts/zol-reply.js:22, zol-threads.js:65)  
   - Append-only text files (`~/.reply-seen`, `~/.threads-seen`)
   - Prevents re-processing old mentions / notifications on daemon restart
   - Seeded on first run from live API (haatz, Neynar) so no duplicates retroactively

2. **Anti-spam guard for hourly posts** (scripts/zol-daily.js:21, 50-56)  
   - `~/zol/recent-casts.json` stores last 24 hourly casts
   - Word-overlap similarity check (50% threshold, scripts/zol-daily.js:61-72)
   - Prevents "same artist 17x/day" spam from model generation drift

3. **Calendar event state** (PR #11, src/calendar-moments.js:12-26)  
   - `~/zol/calendar-state.json` tracks `knownUids[]` and `drafted{event.uid:moment}` booleans
   - Prevents re-drafting same event moment multiple times
   - Collapses multiple due moments (e.g., "new" + "day-before" both fire) into single cast with priority-pick framing

4. **Daemon session tracking** (scripts/zol-reply.js:22, zol-threads.js:65)  
   - Seen-sets persist across restarts so daemons don't re-process old events
   - Startup cold-start: fetch current pending items from API, seed seen-set (zol-reply.js:36, zol-threads.js:~72)
   - Prevents spam on daemon restart

5. **Persona evolution** (scripts/zol-threads.js:~120-130, README.md:169)  
   - `~/zol/zol-persona.md` is the voice seed (read on every draft)
   - Zaal feedback → learned into persona via zol-threads.js
   - Next call to zol-reply, zol-daily, zol-calendar reads updated persona
   - Feedback signal compounds across all posting modes

6. **Approval staging** (scripts/zol-reply.js:54, zol-calendar.js PR #11)  
   - `~/zol/drafts/<id>.json` holds staged content indefinitely until approved
   - Survives daemon crashes, Pi reboots, cron skips
   - Dashboard polls drafts directory every page load (scripts/dashboard.js:6)

### 2.2 Error Handling & Graceful Degradation

1. **Timeout guards** (scripts/zol-daily.js:87 `AbortSignal.timeout(45000)`, zol-reply.js:40s)  
   - LLM drafting calls 45s timeout (returns null if timeout)
   - Hub submission timeout 12s (retry on failure)
   - Falls back to null if model unavailable (continues silently or prints error)

2. **Bonfire read fallback** (scripts/zol-reply.js:26-27, docs/zao-context.md:64-75)  
   - If Bonfire `/delve` times out or returns empty, recall() returns `''`
   - Draft proceeds with whatever context is available
   - No crash on missing Bonfire (labeled data not yet available anyway)

3. **Retry on transient errors** (scripts/zol-reply.js:61-62)  
   - Daemon counts failures, pings Zaal on every 3rd consecutive error
   - Continues polling without breaking

4. **Envfile fallback** (src/zol-lib.js:8-9, ork() fallback patterns throughout)  
   - If env file missing, envfile() returns empty object (silent fail)
   - Scripts check for missing keys and skip LLM features if key unavailable
   - Overnight.js has heuristic fallback if OpenRouter key missing (scripts/overnight.js:38-48)

5. **Dashboard resilience** (scripts/dashboard.js:6)  
   - Reads drafts directory with try/catch, returns `[]` on error
   - Page still renders even if drafts directory corruption/permission issue

### 2.3 Observability & Recovery

1. **Telegram pings** (every daemon sends updates to Zaal)  
   - Startup notification (ready state)
   - Every mention/thread/calendar event triggers a Telegram message (no action taken silently)
   - Error pings include the error message (first 80-200 chars)
   - Overnight report auto-pings summary once when report is ready (zol-reply.js:40-41)

2. **Logging to Bonfire** (scripts/zol-daily.js:106-110, zol-reply.js:55)  
   - Every posted cast logged as Bonfire episode (optional, non-blocking)
   - Every mention + draft logged as pending episode
   - Bonfire serves as an audit trail (even if reads are currently gated)

3. **Local logs** (each script's console output captured in cron mail or tmux session)  
   - `npm run check` validates syntax before commit (quick catch)
   - `scripts/secret-scan.sh` blocks secret commits
   - Manual test via `ZOL_DRY=1 node <script>` shows what would happen

### 2.4 What Persistence Patterns Are MISSING

1. **No persistent event loop queue** (no backlog of "try this LLM call again" logic)  
   - Cron jobs are fire-and-forget (succeed or fail in one run)
   - Daemons retry on transient network errors but don't queue failed operations for retry later

2. **No snapshot/rollback** (no checkpoint-based recovery)  
   - If a daemon crash corrupts the seen-set (e.g., partial write), manual recovery needed
   - No write-ahead logging (WAL) for critical state

3. **No memory store** (no cross-run learn-and-apply loop for drafting quality)  
   - Persona grows (learned feedback) but no metrics on "is the model getting better?"
   - No A/B testing infrastructure, no outcome tracking per draft

4. **No bounded budget enforcement** (rely on env var limits, not enforced)  
   - `MAX_RUNTIME_H` is read by overnight.js but not actively polled
   - OpenRouter spend limits not explicitly tracked per run (free tier rate-limits it implicitly)
   - No daily/monthly budget cap with hardstop

5. **No atomic file operations** (risk of corruption on Pi crash mid-write)  
   - `fs.writeFileSync()` is not atomic; a power loss mid-write can corrupt JSON
   - Recent-casts.json or calendar-state.json could become unreadable

---

## 3. GAPS vs Persistent-Agent Target

Assuming the DreamLoops graft targets "durable bounded agent with declarative state + memory routing + evidence-gated self-improvement", here are the gaps:

### 3.1 Declarative Intent (Capsules)

**Gap**: ZOL's posting intents are embedded in script logic, not declarative.  
**Evidence**: Each posting mode (zol-reply, zol-daily, zol-calendar) is a separate script with hard-coded prompts + thresholds.

**Missing**:
- No single config that says "draft a reply to @mentions" (behavior) vs "draft an event announcement" (behavior) vs "curator cast" (behavior)
- No ability to enable/disable posting lanes via config without code changes
- No Capsule-like "intent bundle" listing: persona + prompt template + gates + state keys

**Target state**: A Capsule for each posting lane (Mention Reply, Daily Curator, Calendar Event, Learn-Zaal) declaring what it drafts, when, and how.

### 3.2 Bounded State Machine Loop

**Gap**: Daemons run infinite loops; if the loop stalls or the model gets expensive, no graceful shutdown.  
**Evidence**: scripts/zol-reply.js:39-63 is `for(;;)` with `await sleep(300000)` (5min).

**Missing**:
- No per-iteration cost tracking (how much did this poll round cost in API calls?)
- No budget ceiling per day (stop posting if we've spent $X)
- No loop-iteration timeout/circuit-breaker (abandon the daemon if it hangs for 30min)
- No adaptive rate-limiting (slow down polling if we're hitting errors)

**Target state**: Each daemon iteration is a bounded capsule invocation with cost metadata + early exit on budget/timeout.

### 3.3 Memory Routing & Recall

**Gap**: Memory is scattered across files + hardcoded prompts; no unified routing.  
**Evidence**:
- Persona lives in `~/zol/zol-persona.md` (read fresh each time by each script)
- Bonfire recall is hardcoded into zol-daily/zol-reply prompts
- ICM boxes are documented in `docs/zao-context.md` but not fetched live
- No feedback-loop metadata (when was ZOL corrected? by whom? for what draft?)

**Missing**:
- No central memory index (persona + learned feedback + outcome history)
- No evidence-routing (e.g., "if Zaal corrected ZOL's music taste 3x this week on the same artist, weight that feedback higher")
- No semantic memory (no embedding-based similarity search across feedback)
- No auto-prune of stale learned rules (rules added >6mo ago with no reinforcement)

**Target state**: A memory block (or Bonfire episode store with structured metadata) that capsules query for persona + context, with precedence routing.

### 3.4 Evidence-Gated Self-Improvement

**Gap**: Persona learns from Zaal feedback, but learning is opaque + unvalidated.  
**Evidence**: scripts/zol-threads.js:~120-130 calls `learn()` on Zaal replies, appends to persona.md without validating the extracted rule.

**Missing**:
- No validation that the extracted rule is actionable or doesn't contradict prior rules
- No versioning of persona (can't revert a bad learned rule)
- No outcome metrics (did this rule improve casting quality? or make it worse?)
- No explainability (why was this rule added? what evidence triggered it?)
- No rate-limiting (if Zaal gives 10 pieces of feedback in one session, don't learn all of them immediately)

**Target state**: Learned rules are tagged with source + timestamp + confidence, with a "apply or reject" gate before adding to persona.

### 3.5 Recovery & Rollback

**Gap**: If something breaks (signer key corrupted, persona becomes incoherent), recovery is manual.  
**Evidence**: README.md says "keep the live persona in sync by hand" (README.md:207).

**Missing**:
- No persona rollback (e.g., revert to previous day's version if today's is bad)
- No signer key backup / rotation enforcement
- No state corruption detection (auto-rename corrupted `.json` files and start fresh)
- No canary testing (test a draft on a small audience before wide posting)

**Target state**: Checkpointed state snapshots with rollback capability + corruption detection.

### 3.6 Cross-Capsule Coordination

**Gap**: Each posting lane is independent; no coordination between daemons.  
**Evidence**: zol-reply (mentions) and zol-calendar (events) both draft independently; if they both fire at same time, Zaal sees two separate Telegram messages.

**Missing**:
- No batching of drafts (combine multiple small drafts into a single Telegram for review)
- No priority ordering (if a calendar event is "morning-of" and a mention arrives, which takes precedence in Telegram?)
- No state hand-off (no way for one capsule to say "I drafted for this event, skip it elsewhere")

**Target state**: A coordinator that sequences capsule invocations and can batch or prioritize outputs.

---

## 4. RISKS of Grafting DreamLoops onto ZOL

### 4.1 Signer Proximity (HIGH RISK)

**Risk**: The Ed25519 signer key (`~/.openclaw/farcaster-credentials.json`) is currently read by multiple scripts in a single process. Adding a DreamLoops runtime (which may spawn subprocesses, workers, or RPC calls) could expose the key.

**Scenario**: If DreamLoops uses a worker pool or spawns child processes, and the key is passed via env var or shared memory, the key could leak or be logged.

**Mitigation**:
- Keep signer reading in the main process only
- Never pass the key to worker processes or RPC calls
- Store key path (not key material) in DreamLoops config
- Each capsule reads the key locally when needed, never from env

**Impact on Graft**: Tight coupling. The signer must remain a tightly-held resource in the Pi's main ZOL process, not a service DreamLoops can call.

### 4.2 Raspberry Pi Resource Ceilings (MEDIUM-HIGH RISK)

**Risk**: The Pi has limited CPU, RAM, and disk. Adding a DreamLoops runtime + persistent state machine could push it over the edge.

**Scenarios**:
- If DreamLoops keeps an in-memory queue of capsule invocations, a busy day (many mentions + calendar events) could exhaust RAM
- If state snapshots are written to disk per-iteration, disk I/O could bottleneck
- If daemons' sleep intervals are reduced (from 5min to 30s for more reactivity), CPU usage spikes

**Constraints on ZOL's Pi**:
- Raspberry Pi 4 (2GB or 4GB RAM typical)
- NVMe or SD card storage (slow I/O)
- No external database (can't push state off-Pi)
- Power failures are common (brownouts, manual power cuts)

**Mitigation**:
- Use SQLite with WAL (write-ahead logging) for atomic state updates, not append-only JSON
- Cap queue size (drop oldest drafts if queue grows beyond 100)
- Lazy-load capsules (don't keep all daemons in memory, spawn on-demand)
- Validate CPU/RAM usage with load testing before deploying to Pi

**Impact on Graft**: Substantial. State adapter choice (SQLite vs atomic files) is load-bearing on Pi stability.

### 4.3 Zero-Spend Boundary (MEDIUM RISK)

**Risk**: DreamLoops adds self-improvement loops (retry, re-sample, re-rank). If not carefully bounded, ZOL could exceed its LLM budget.

**Scenarios**:
- A single mention that times out could be retried 3x, tripling the cost
- A low-confidence draft could be re-drafted, then re-sampled, then re-ranked (3x cost)
- The budget limits are env vars read once, not enforced per-iteration

**Current Budget**:
- OpenRouter free tier: ~50-60 casts/day before rate-limit (README.md:279)
- Each cast draft: ~1000 tokens in, ~200 out (~$0.0001-0.001 per draft depending on rate)
- No monthly limit enforced, implicit free-tier cap

**Mitigation**:
- Hard-cap retry budget per capsule invocation (max 1 retry per draft, not 3)
- Track cumulative cost per day in a counter file (`~/zol/daily-spend.json`)
- Refuse new drafts if daily budget exceeded (don't retry or re-sample)
- Alert Zaal if we hit 70% of daily budget

**Impact on Graft**: Moderate. Requires explicit budget tracking + enforcement code, but is orthogonal to DreamLoops core (just needs hooks).

### 4.4 Model Drift (MEDIUM RISK)

**Risk**: If DreamLoops adds auto-tuning of prompts or temperature, the model's behavior could diverge from ZOL's voice.

**Scenarios**:
- A capsule tries different `temperature` values to get more variety; suddenly ZOL's casts are sloppy or overly formal
- Prompt engineering experiments fail silently (model returns null), cascading failures
- Learned feedback rules interact poorly (persona becomes contradictory)

**Current State**:
- Temperature is hardcoded per script (0.7-0.85 range, scripts/zol-daily.js:87, zol-reply.js:32)
- Prompts are hardcoded in each script header
- Persona is hand-edited by Zaal or auto-learned from Zaal feedback

**Mitigation**:
- Lock prompts + temperature in Capsule config (no auto-tuning)
- Persona changes only via explicit `LEARN=1` flag (require Zaal opt-in per learned rule)
- Test mode: `ZOL_DRY=1` shows what would post, never actually posts
- Audit: every persona change is logged to Bonfire with metadata (date, feedback source)

**Impact on Graft**: Low. Requires discipline (freezing prompts) but is an operational choice, not architecture.

### 4.5 State Corruption on Pi Reboot (MEDIUM RISK)

**Risk**: The Pi has power instability. If a state write is interrupted (e.g., `calendar-state.json` mid-write), the JSON becomes unreadable and the daemon crashes.

**Current State**:
- `fs.writeFileSync()` is not atomic
- No backup files or rollback
- Seen-sets are append-only (safer than RW, but still vulnerable)

**Scenarios**:
- Pi power-cycles during `fs.writeFileSync(STATE_PATH, JSON.stringify(state))`
- calendar-state.json becomes `{broken json}`
- Next cron run of zol-calendar.js crashes trying to parse it
- Zaal gets error Telegram, has to manually recover

**Mitigation**:
- Use SQLite with `PRAGMA journal_mode=WAL` (atomic writes guaranteed)
- Or: write to temp file, then rename (atomic on POSIX filesystems)
- Add state recovery: if JSON parse fails, back up corrupted file + reset to empty state (fresh cold-start)
- Unit test state read/write with simulated corruption

**Impact on Graft**: High. The state adapter (SQLite vs files) directly mitigates this risk.

### 4.6 Model Timeout Cascade (LOW-MEDIUM RISK)

**Risk**: If OpenRouter is slow or offline, timeouts cascade through multiple daemons.

**Scenarios**:
- zol-daily.js times out on LLM call (45s), then immediately zol-reply gets a mention, also times out
- Three timeouts in 5min → Zaal gets 3 error pings in a row (noisy)
- Overnight.js hits MAX_RUNTIME_H while waiting for slow model response

**Current State**:
- Each script has independent timeout (45s, 40s per call)
- No shared semaphore or rate-limiting between daemons
- Retry logic is per-daemon (no global backoff)

**Mitigation**:
- Implement a per-daemon rate-limiter (skip LLM calls if OpenRouter is erroring)
- Share timeout state between daemons (if 2 timeouts in 5min, all daemons skip LLM for next 10min)
- Add OpenRouter status check (ping API before drafting, fail-fast if down)

**Impact on Graft**: Low. Requires a lightweight coordination mechanism, but doesn't break DreamLoops core.

---

## 5. IMPLEMENTATION MAP - Phased Graft Strategy

This map outlines how to graft DreamLoops onto ZOL in small, reviewable chunks. Each phase is a single PR.

### Phase 0 (CURRENT): Audit
- **PR**: docs/persistent-agent-audit.md (this doc)
- **Scope**: Read-only. Ground the graft plan in actual code + state files.
- **Deliverable**: This audit doc + link to DreamLoops commit 1c6d3b19
- **Risk**: None (no code changes)

### Phase 1: Vendor DreamLoops Runtime (No Integration Yet)

**Goal**: Add DreamLoops to package.json without wiring it into ZOL logic.

**PR Checklist**:
- [ ] Add DreamLoops to `package.json` dependencies (pinned to commit 1c6d3b1910...)
- [ ] Add a `docs/dreamloops-integration-plan.md` with the phases below
- [ ] Create `src/zol-capsules/` directory (empty, reserved for capsule definitions)
- [ ] Add `src/zol-runtime.js` (stub: exports a function to load capsules, but no capsules defined yet)
- [ ] Update `.env.example` with new DreamLoops-specific vars (e.g., `DREAMLOOPS_STATE_ADAPTER`, `DREAMLOOPS_BUDGET_DAILY_CENTS`)
- [ ] Update `README.md` "Known Limitations" section to mention "DreamLoops integration in progress, Phase 1 of 5"

**Files Changed**: `package.json`, `docs/`, `src/zol-runtime.js` (stub), `.env.example`, `README.md`

**No Breaking Changes**: Existing scripts still run unchanged. DreamLoops is inert.

**Test Plan**:
- [ ] `npm install` completes without errors
- [ ] `npm run check` passes all scripts (DreamLoops code not executed)
- [ ] Existing daemon + cron jobs still work (manual test on Pi)

---

### Phase 2: State Adapter (SQLite WAL)

**Goal**: Replace file-based state with SQLite, mitigating corruption risk on Pi reboot.

**Reason**: SQLite with WAL mode gives atomic writes (corruption-safe) on Pi's filesystem. Switching to this now (before DreamLoops) reduces the number of changes in later phases.

**PR Checklist**:
- [ ] Add `better-sqlite3` to `package.json` (lightweight, sync, no async event loop complications)
- [ ] Create `src/zol-state.js`:
  - Initialize SQLite DB at `~/.zol/zol-state.db`
  - Schema: `CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT)` + indices for seen-sets
  - Migrations: write one-shot `01_initial.sql` (checked in repo)
  - Exports: `getState(key)`, `setState(key, value)`, `appendSeen(key, hash)`, `getSeen(key)`
- [ ] Create backward-compat layer: `src/zol-state-migrate.js`
  - On first run, reads old `.json`/`.txt` files and imports into SQLite
  - Backs up old files to `~/.zol/backup/` (with timestamp)
- [ ] Update `scripts/zol-daily.js`, `zol-reply.js`, `zol-threads.js`, `zol-calendar.js` (PR #11 post-merge):
  - Replace `fs.readFileSync(RECENT_PATH)` + `JSON.parse()` with `zol-state.getState('recent-casts')`
  - Replace `fs.writeFileSync()` with `zol-state.setState()`
  - Replace `fs.appendFileSync(SEEN)` with `zol-state.appendSeen()`
- [ ] Add state integrity checks: `src/zol-state-check.js` (run as `npm run check-state` on the Pi)
- [ ] Update `.env.example`: `ZOL_STATE_PATH` (default `~/.zol/zol-state.db`)

**Files Changed**: `package.json`, `src/zol-state.js`, `src/zol-state-migrate.js`, `scripts/*.js`, `.env.example`

**No Breaking Changes**: Migration is transparent (old files auto-imported on first run). Existing daemons + crons still work.

**Test Plan**:
- [ ] On fresh Pi: `npm install && npm run check-state` creates DB + schema
- [ ] On existing Pi: first run of any daemon migrates old state to DB + backs up old files
- [ ] Simulate Pi power-cycle mid-write: `better-sqlite3` WAL mode ensures no corruption
- [ ] Existing Telegram pings + approvals still work (same interface)

---

### Phase 3: Budget Enforcement

**Goal**: Hard-cap ZOL's daily LLM spend before DreamLoops adds retries.

**Reason**: If DreamLoops enables retry loops, we need a budget guard to prevent runaway costs.

**PR Checklist**:
- [ ] Create `src/zol-budget.js`:
  - Track daily spend in SQLite table: `cost_log (timestamp INTEGER, model TEXT, tokens_in INTEGER, tokens_out INTEGER, cost_cents REAL)`
  - Exports: `logCost(tokens_in, tokens_out)`, `dailySpent()`, `canAfford(tokens_in)`, `checkBudget()` (throws if over budget)
  - Budget source: `DREAMLOOPS_BUDGET_DAILY_CENTS` env var (default: 50 cents = ~500 drafts)
- [ ] Update `src/zol-lib.js` `ork()` function:
  - After OpenRouter response, parse `x-openrouter-generation-tokens` header
  - Call `zol-budget.logCost()` with actual tokens
  - If daily budget exceeded, return null (treat like timeout)
- [ ] Add `npm run budget-report`: shows today's spend + % of budget used
- [ ] Update `.env.example`: `DREAMLOOPS_BUDGET_DAILY_CENTS` (default 50)

**Files Changed**: `src/zol-budget.js`, `src/zol-lib.js`, `package.json`, `.env.example`

**No Breaking Changes**: Default budget is generous (well above typical daily spend). Daemons still run. Spend is only logged, not yet enforced per-capsule.

**Test Plan**:
- [ ] `npm run budget-report` after a day of normal operation
- [ ] Manual: set `DREAMLOOPS_BUDGET_DAILY_CENTS=1` (1 cent, ~10 tokens), run zol-daily, see it refuse drafts when budget exceeded
- [ ] Spending per draft is logged and retrievable

---

### Phase 4: Capsule Framework (No Behavioral Changes Yet)

**Goal**: Define ZOL's posting intents as Capsules, without changing how they run.

**Reason**: DreamLoops requires declarative intent (Capsules). We extract the intent from existing code, making the intent explicit but behavior unchanged.

**PR Checklist**:
- [ ] Create `src/zol-capsules/` directory structure:
  ```
  src/zol-capsules/
    index.js                    # exports all capsules
    mention-reply.capsule.js    # Capsule for zol-reply.js
    curator-cast.capsule.js     # Capsule for zol-daily.js
    calendar-event.capsule.js   # Capsule for zol-calendar.js
    learn-zaal.capsule.js       # Capsule for zol-threads.js
  ```
- [ ] Each Capsule exports:
  ```javascript
  module.exports = {
    id: 'mention-reply',
    mode: 'gated',  // or 'auto' for zol-daily
    schedule: '*/5 * * * *',  // cron line or 'daemon'
    persona: 'music-curator',
    prompt: '...',  // extracted from script
    constraints: {
      maxChars: 320,
      temperature: 0.8,
      timeout: 40000,  // ms
      model: 'anthropic/claude-fable-5',
    },
    gates: {
      requireApproval: true,  // or false for auto-post
      stateKeys: ['seen-mentions'],  // which state tables to load
    },
    state: {
      outputTopic: 'drafts-mention-reply',  // where to write staged drafts
      stateKey: 'seen-mentions',  // where to track seen hashes
    },
  };
  ```
- [ ] Rewrite scripts to use Capsules (optional in Phase 4, defer to Phase 5)
- [ ] Create `src/zol-runtime.js`:
  - Loads all Capsules from `src/zol-capsules/`
  - Exports: `getCapsule(id)`, `listCapsules()`, `invokeCapsule(capsule, input)` (stub, real invoke in Phase 5)
- [ ] Add `docs/zol-capsules.md`: reference docs for each Capsule (persona, prompt, gates, state keys)
- [ ] Update `.env.example`: `ZOL_CAPSULES_ENABLED` (default: all)

**Files Changed**: `src/zol-capsules/`, `src/zol-runtime.js`, `docs/zol-capsules.md`, `.env.example`

**No Breaking Changes**: Old scripts still run unchanged. Capsules are defined but not yet invoked.

**Test Plan**:
- [ ] `node -e "const C = require('./src/zol-runtime.js'); console.log(C.listCapsules());"` lists 4 capsules
- [ ] Each Capsule has required fields (id, mode, persona, prompt, constraints, gates)
- [ ] Existing daemons + crons still work unchanged (no new invocation path yet)
- [ ] `npm run check` passes

---

### Phase 5: DreamLoops Invocation (First Behavioral Change)

**Goal**: Wire Capsules into DreamLoops runtime. Daemons now invoke Capsules as DreamLoops state-machine iterations.

**Reason**: This is where DreamLoops' bounded loops, budget enforcement, and memory routing actually take effect.

**PR Checklist**:
- [ ] Create `src/zol-dreamloops.js`:
  - Initializes DreamLoops runtime with SQLite adapter (from Phase 2)
  - Registers all Capsules from Phase 4
  - Exports: `runCapsule(id, input)` → Promise with budget enforcement + timeout
  - Wraps ork() calls with budget checking (don't call if budget exceeded)
- [ ] Rewrite daemon entry points to use DreamLoops:
  - `scripts/zol-reply.js`: replace inline loop with `while (true) { await zol-dreamloops.runCapsule('mention-reply', {...}); sleep(5min) }`
  - `scripts/zol-threads.js`: same pattern
  - `scripts/zol-learn-zaal.js`: same pattern
  - Cron scripts (zol-daily, zol-calendar) can stay as-is (single-shot crons don't need the loop)
- [ ] Update `src/zol-runtime.js` `invokeCapsule()`:
  - Calls DreamLoops runtime (from zol-dreamloops.js)
  - Budget checking happens here (throws if over budget)
  - Timeout wrapper: max 50s per Capsule invocation
- [ ] Add memory routing (basic):
  - Capsules request persona via `getMemory('persona')`
  - Capsules request context via `getMemory('zao-context')`
  - Bonfire recall is done via `getMemory('bonfire-delve', query)`
  - All memory reads go through a router that caches + de-dupes requests
- [ ] Update Telegram pings to include budget status: "Posted. Daily budget: 34/50 cents (68%)."
- [ ] Add a new env var: `DREAMLOOPS_STATE_ADAPTER` (default: 'sqlite', could be 'file' for backward-compat)

**Files Changed**: `src/zol-dreamloops.js`, `scripts/zol-reply.js`, `scripts/zol-threads.js`, `scripts/zol-learn-zaal.js`, `src/zol-runtime.js`, `.env.example`, `README.md`

**Breaking Changes**: YES, but gated behind `DREAMLOOPS_ENABLED=true` env var. By default, daemons still use old loop logic. On Pi, Zaal enables it after testing.

**Test Plan**:
- [ ] Dev: `DREAMLOOPS_ENABLED=true node scripts/zol-reply.js` runs 1 iteration of mention-reply Capsule, then exits (or stays in loop)
- [ ] Dev: `ZOL_DRY=1 node scripts/zol-daily.js` still works (DreamLoops is opt-in)
- [ ] Pi (after Zaal's go-ahead): enable `DREAMLOOPS_ENABLED=true` in start-fleet.sh, monitor for 1 day, then make permanent
- [ ] Budget enforcement: set `DREAMLOOPS_BUDGET_DAILY_CENTS=10`, run multiple mentions, see ZOL stop drafting when budget hit

---

### Phase 6: Evidence-Gated Learning (Optional Follow-Up, Not in Initial Graft)

**Goal**: Add explainability + validation to Zaal feedback → persona learning.

**Reason**: Phase 5 gets the core DreamLoops loop working. Learning improvements can be a separate, lower-priority follow-up.

**Plan Outline** (for future PR):
- [ ] Create `src/zol-learning.js`:
  - When Zaal replies to a ZOL cast, extract feedback via ork()
  - Generate a proposed rule + confidence score (0-100%)
  - Store in DB with metadata: {proposed_rule, confidence, source_fid, source_cast_hash, timestamp, status: 'pending'}
  - Ping Zaal on Telegram: "Learned from your feedback. Accept this rule? [Yes / No / Edit]"
  - Zaal approves via Telegram button callback (integrated with ZOE bot)
  - On approval: move status to 'accepted', append to persona.md with metadata
  - On rejection: mark status 'rejected', log reason if provided
- [ ] Persona now has version history + rollback capability
- [ ] Add `npm run persona-audit`: show all learned rules, oldest ones, confidence scores, and impact (how many times has this rule been cited?)

**Phase 6 is deferred** because it adds complexity (Telegram buttons, feedback state machine) and Phase 5 already delivers the core DreamLoops value (bounded loops, budget, memory routing).

---

### Deployment Plan (Pi Integration)

Once all phases are merged to `main`, deploy to Pi in this order:

1. **Backup**: `ssh zaal@ansuz 'cp -r ~/zol/farcaster-agent ~/zol/farcaster-agent.backup-2026-07-14'`
2. **Merge phases** 1-5 to `main`
3. **SSH to Pi**: 
   ```bash
   ssh zaal@ansuz
   cd ~/zol/farcaster-agent
   git pull
   npm install  # Phase 1 adds DreamLoops
   npm run check  # All scripts pass syntax check
   npm run check-state  # Phase 2: migrate old state to SQLite or initialize fresh
   npm run budget-report  # Phase 3: verify budget tracking works
   ```
4. **Test in dry-run**:
   ```bash
   ZOL_DRY=1 node scripts/zol-daily.js
   ZOL_DRY=1 DREAMLOOPS_ENABLED=true node scripts/zol-reply.js  # 1 iteration only
   ```
5. **Enable gradually**:
   - Keep `DREAMLOOPS_ENABLED=false` (default) for 3 days (monitor old path)
   - Then set `DREAMLOOPS_ENABLED=true` in `~/zol/.env.local` (one daemon at a time)
   - Monitor Telegram + dashboard for 1 day per daemon
   - Once confident, switch start-fleet.sh to use new path

---

## 6. Recommended State-Adapter Choice for Pi

**Recommendation**: **SQLite with WAL mode** (Phase 2).

### Rationale

1. **Atomic writes on Pi**: WAL (Write-Ahead Logging) guarantees that a crash mid-write doesn't corrupt the database. On a Pi with power instability, this is load-bearing.

2. **Single-file storage**: Unlike multiple `.json` files scattered in `~/zol/`, a single `zol-state.db` file is easier to backup + monitor.

3. **Query support**: If future phases want to query state (e.g., "how many mentions did we get this week?"), SQL is more powerful than grep-ing `.json` files.

4. **No external DB**: better-sqlite3 is file-based (no separate server), so no network dependency or startup order issues on the Pi.

5. **Backward compatibility**: Phase 2 includes auto-migration from old files, so no manual Pi intervention needed on first upgrade.

### Alternative Considered: Atomic File Operations

**Option**: Write to temp file, then rename (atomic on POSIX).

**Pros**: 
- Zero new dependencies (vs `better-sqlite3` adds ~5MB to node_modules)
- Each state key is independent (one file per key), easy to understand

**Cons**:
- Still vulnerable if Pi crashes during the write syscall itself (rare, but not zero-risk)
- Scattered files are harder to backup / monitor
- No query support (can't ask "what's the average draft time?")

**Verdict**: File atomicity is better than `fs.writeFileSync()` (current), but worse than SQLite WAL. SQLite is the clear winner for a Pi with power instability.

---

## Summary Table

| Phase | Deliverable | Risk | Breaking Changes | Estimated Effort |
|-------|-------------|------|------------------|------------------|
| **0** | audit.md | None | No | Done (this doc) |
| **1** | Vendor DreamLoops | Low | No | ~2 hours (add dep, stubs) |
| **2** | SQLite state adapter | Low | No (transparent migration) | ~6 hours (schema, migrate, tests) |
| **3** | Budget enforcement | Low | No | ~4 hours (tracking, reporting) |
| **4** | Capsule framework | None | No (capsules not invoked yet) | ~6 hours (define 4 capsules, docs) |
| **5** | DreamLoops invocation | Medium | Yes (gated behind DREAMLOOPS_ENABLED) | ~8 hours (wire loops, memory routing, Telegram status) |
| **6** | Evidence-gated learning | Medium | No (optional) | ~8 hours (deferred to next quarter) |

**Total (Phases 0-5)**: ~26 hours of development + review + Pi testing. Recommend spreading over 2-3 weeks with daily monitoring on Pi after each phase lands.

---

## Notes for Reviewers

- **No code changes in Phase 0**: This audit doc only. All risks and gaps are documented, not fixed here.
- **Phase 1 is pure prep**: Adding a dependency that's not yet used. Safe to merge quickly.
- **Phase 2 is foundational**: Switching to SQLite is a prerequisite for Phases 3-5. Do this early so we validate state handling before DreamLoops complexity.
- **Phase 5 is the big change**: This is where the loop structure fundamentally shifts from hand-coded to DreamLoops-orchestrated. Plan for careful testing + rollback if needed.
- **Budget enforcement (Phase 3) is critical**: If DreamLoops enables retries, we must have hard budget caps to prevent runaway costs. Don't defer.
- **Memory routing is minimal in Phase 5**: Just route persona + context fetch calls through a simple cache. Evidence-gated learning (Phase 6) is a nice-to-have, not a blocker for shipping Phase 5.

---

## References

- **ZOL README**: `README.md` (architecture, daemons, approval flow)
- **ZOL Persona**: `persona.md` (voice constitution)
- **Scripts**: `scripts/*.js` (zol-daily, zol-reply, zol-threads, zol-calendar in PR #11)
- **State files**: implicit in script reads/writes (recent-casts.json, .reply-seen, calendar-state.json, zol-persona.md)
- **DreamLoops Spec**: github.com/BrandonDucar/dreamloops commit 1c6d3b1910f5b83639e0735634740902e2caacff
- **Audit Context**: research/agents/928-agent-loop-best-practices (Anthropic loop learnings, 2026-06-30)
- **ZOL Context**: docs/zao-context.md, research docs 974 (WaveWarZ), 891 + 993 (ZOL upgrade planning)
