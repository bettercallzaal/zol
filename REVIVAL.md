# ZOL Revival

Working doc for the revive. Re-verified 2026-08-25 from branch
`ws/dreamloop-artist-spotlight`. No credentials read for their values, nothing
deployed, nothing pushed.

**Scope and root cause are already settled.** See
`~/zao-vault/notes/zol-revive-scope.md` (metawall card `746bfbcf`, fractal lane
2026-08-20, live Pi probe). That note owns findings 1-5, the phase table, and the
DreamLoops verdict. This doc does not restate it.

What this doc adds:

1. A five-day re-verification of the scope note's liveness claims, with the
   evidence and three corrections.
2. The Farcaster @tag-listening path, which is Zaal's new goal and post-dates the
   scope note.
3. The short Zaal-tap list at the end.

---

## 1. Re-verification, 2026-08-25

The Pi is not reachable from this mac (`ansuz.lan` -> `192.168.40.79`, no route;
`tailscale status` reports **Tailscale is stopped** locally). So the scope note's
claims were re-checked from the Farcaster side, which is sufficient for four of
them and insufficient for one.

### CONFIRMED - "everything else still runs"

`zol-follow.js` is a signing, hub-submitting cron with **no LLM call**, so it is
the clean probe. Pulled from the haatz mirror during this audit:

```
follows per day, newest first
  2026-08-25   20      <- today, 19:00 UTC
  2026-08-24   20
  2026-08-23   20
  ... unbroken ...
  2026-08-16   20
```

Exactly 20 per day, its configured cap, every day without a miss, including
today. That single fact proves the Pi is powered and networked, cron is firing,
the Ed25519 signer at `~/.openclaw/farcaster-credentials.json` is intact, the
Neynar key works, and `hub-api.neynar.com/v1/submitMessage` is accepting ZOL's
messages. Five days after the scope note's probe, finding 1's "signer, Neynar
key, Telegram pings: intact" still holds.

### CONFIRMED - the daily cast is still dark

Last root cast remains **2026-08-03 16:00 UTC**. Twenty-two days. Nothing has
recovered on its own, which is what "out of credits" predicts.

### CONFIRMED - `zabal-watch */5` is live

Reply casts landed 2026-08-04, 08-08, 08-09, 08-14 and 08-22. That is the daemon
the scope note flags as LIVE, and it is why ZOL looks alive on the timeline while
the curator cast is dead.

### NOT VERIFIABLE REMOTELY - the `zol-reply` mention daemon

Its output is a file in `~/zol/drafts/` plus a Telegram ping. Both are private, so
a healthy daemon and a crashed one look identical from outside. The scope note's
2026-08-20 Pi probe says it runs; nothing since contradicts that, but it is
assumption, not measurement, until someone is on the box. **This matters more than
it used to, because it is now the critical path.** First command of any Pi
session: `tmux ls` and confirm session `zol` is alive.

---

## 2. Three corrections to the scope note

### 2a. Credit exhaustion is not total, so the top-up may not be sufficient alone

Finding 1 says every run since Aug 3 fails with "Insufficient credits" across the
whole ladder. But `scripts/zol-zabal-watch.js` reads the **same**
`~/.zao/private/openrouter.key`, calls the **same** default model
`anthropic/claude-fable-5` with **no** failover ladder, and successfully drafted
and posted replies as recently as **2026-08-22**.

So OpenRouter was serving that key nineteen days into the supposed outage. Two
readings: credits are intermittent (a partial top-up, or free-tier quota that
resets and that hourly `zol-daily` exhausts first), or `zol-daily` has a second
failure cause wearing the credits error as a coat.

Not a contradiction of "not dead", and not a reason to delay the tap. It is a
reason to **read `~/zol/last-failure.json` before and after topping up** - the
throttle writes the real per-rung error text there - rather than assuming the
money fixed it. Cheap check, avoids a false "revived".

### 2b. The failover ladder has two provenances that may collide

The scope note names the ladder as already present on the Pi (`claude-fable-5`,
`deepseek-chat`, `llama-3.3-70b`). Meanwhile local commit `3521015`, made today
and **unpushed**, adds that same three-rung ladder to `scripts/zol-daily.js`,
plus the 6h failure-ping throttle.

Finding 4 records the Pi's clone sitting on `zao/zol-rate-limit`, ahead of
upstream main and push-credless by design. So the Pi probably already carries a
ladder that upstream lacks, and `3521015` is likely a parallel reimplementation of
it. **Do not `git pull` the Pi blind.** Diff `zao/zol-rate-limit` against this
branch first and decide which ladder survives; the rate-limit branch also carries
the 2-posts-per-4h cap that must not be lost.

### 2c. `zolbot` does exist, and it is this directory

Finding 4 says no `~/zolbot` exists on the Pi or the Mac, and that the July card's
stray branch was probably a vanished `/tmp` clone. Half right: not `~/zolbot`, but
`/Users/zaalpanthaki/Documents/zolbot` is real, is the working copy this document
is being written in, and is sitting on exactly the branch and index state the July
card described - `ws/dreamloop-artist-spotlight`, 13 files staged-added then
deleted from disk.

Preserved twice before this audit touched anything, so no reset is needed to make
it safe:

- file copies under the session scratchpad `index-backup/` (211 files)
- GC-proof snapshot ref `refs/backup/index-snapshot-2026-08-25`
  (`c1fe4f3c658c997ba9679424d7f7b3ee19abeb05`)

All 13 blobs verified present in the object store, and their content is already
merged on origin via PRs #20, #21 and #12. Branch hygiene here is finding 4's
item, unchanged in priority. It is not blocking anything.

---

## 3. The @tag path (new, post-dates the scope note)

Goal: Zaal tags @zolbot on Farcaster and ZOL learns about the tagged thing. The
scope note predates this ask, so nothing below revisits it.

The listener already exists and is architecturally fine.
`scripts/zol-reply.js` polls `haatz.quilibrium.com/v1/castsByMention?fid=3338501`
every 300s, dedupes against `~/zol/.reply-seen`, drafts, writes
`~/zol/drafts/<hash>.json`, and pings Telegram with a one-line approve command.
That endpoint was verified live during this audit: HTTP 200, 12 mentions, no API
key required. Three things stand between it and the goal.

### Blocker 1 - ZOL is hardcoded to ignore Zaal

`scripts/zol-reply.js:52`

```js
if(pfid===19640){continue;} // skip owner's own casts - ZOL does not reply to Zaal announcements
```

FID 19640 is Zaal. Every cast he tags ZOL in is dropped at ingestion, before
drafting, before the ping. Added 2026-07-13 in `8525946` to stop ZOL replying to
launch announcements. The side effect is that the exact interaction now being
asked for cannot occur.

Evidence it has been costing real interactions - mentions from Zaal, all
unanswered:

| When | Gist |
|---|---|
| 2026-07-12 | find the zabalgamez recording links for empire builder |
| 2026-07-19 | wants to tip people on the timeline by tagging ZOL |
| 2026-08-03 | how can I make ZOL better at interacting with other accounts |
| 2026-08-03 | can u do any of that |

ZOL has replied to Zaal once ever: 2026-07-13, "Got it. Locked that in." That was
`zol-threads.js` acking feedback on ZOL's own cast, not an answer to a tag.

Fix: narrow the guard instead of deleting it. Skip fid 19640 only when the cast
has no `parentCastId` **and** carries several mentions, which is the broadcast
shape the rule was written for. A direct tag or a reply goes through.

### Blocker 2 - the tagged thing is thrown away

Grepping all of `scripts/` and `src/` for `castAddBody.embeds` or `embeds[`
returns **nothing**. ZOL reads a mention's `text` and discards its embeds. Tag it
with a track link, an artist page, or a quoted cast and it sees a sentence with a
URL-shaped hole in it. This is the "learns about the tagged thing" half, and it is
a build, not a repair.

Fix: in the mention loop, read `m.data.castAddBody.embeds`. Fetch each `url` and
extract title plus text; resolve each `castId` through haatz `castById`. Feed both
into the draft prompt as context. Bound it - 3 embeds max, 8s timeout each, 2KB
extracted per embed, failures skipped silently.

### Blocker 3 - nowhere durable to put what it learned

`src/state-adapter.js` is already the answer and is already written and tested: a
three-backend key/value store with receipts (atomic file, sqlite WAL, Bonfire),
reachable through `createStateStore()`. `~/zol/state/` already exists.

Fix: persist `{mention hash, from fid, text, resolved embeds, draft, timestamp}`
through the atomic-file backend. No new dependency, no Bonfire requirement,
survives a restart. Keep the existing `logGraph()` Bonfire write as a best-effort
second sink. Do **not** reach for DreamLoops capsule state here - per the scope
note's finding 3, that is merged, flag-gated and a phase 1 activation decision,
not part of this.

### The coupling nobody has stated yet

`zol-reply.js` drafts through OpenRouter, and on a null draft it pings Telegram
with "no draft - add the OpenRouter key". **The credit tap is a prerequisite for
tag-and-learn, not just for the daily cast.** Without it, fixing blockers 1-3
produces a bot that notices Zaal's tag, fetches the link, and then tells him it
cannot think. Worth noting too that `zol-reply.js` has no failover ladder at all -
one model, one shot - so it should inherit the `3521015` ladder while that code is
open anyway.

### Order of work

1. Credit tap (section 5). Everything else is decoration without it.
2. `tmux ls` on the Pi, confirm session `zol` is alive. Resolves the one claim
   this audit could not.
3. Narrow the fid 19640 guard.
4. Read embeds, persist through `createStateStore()`, give `zol-reply` the ladder.
5. Deploy the way the Pi actually works: `git pull` in `~/zol/farcaster-agent`
   (after the 2b diff), then `tmux kill-session -t zol` and let `start-fleet.sh`
   respawn it within 15 minutes. **Do not run `deploy/migrate.sh`** - its own
   README says it is a build-only kit never executed against the real Pi.
6. Live test: Zaal tags @zolbot with a link. Expected within 5 minutes, a Telegram
   draft that demonstrably references the linked thing, plus a new entry under
   `~/zol/state/`. Approval stays manual for the first several.

Unchanged throughout: the approval gate, the bot blocklist, the double-tag guard,
the `@`-stripping on output, the no-spend guarantee. Step 3 widens who ZOL listens
to. It does not widen what ZOL can do.

The 2026-07-19 tipping tag is a different risk class and stays out of this. It is
the scope note's `ef98e806` (Empire Builder, scoped signer key or stay gated), and
it gets its own decision.

---

## 4. The 11 PRs - decided REVIVE

Zaal decided REVIVE on 2026-08-25 for **#29, #30, #40, #42, #43, #44, #45, #46,
#53, #57, #60**. Verified against `bettercallzaal/zol` during this audit: all 11
are open, all marked ready (not draft), all touched 2026-08-25. None have been
closed out from under the decision. Not re-litigated here.

Two of them touch this doc's path and should be sequenced against it rather than
merged blind: **#40** (ZOE to ZOL intent bridge design) and **#57** (wire
`cast.draft` + `artifact.draft.write` + toolgating). Read both before writing the
mention-loop change in section 3, or the same wiring gets built twice.

Separately, **#65-69** are still open but are **drafts** and untouched since late
July, which is softer than the scope note's "awaiting merge" framing. They belong
to finding 4's branch-hygiene item, not to the revive.

Repo state note: `origin/main` has moved to `8b3339a`, past the `6199a72` this
branch's remote ref knows about, and `feat/activate-weekly-curator-artist-spotlight`
exists remotely. Reconcile before any push. This branch also carries three unpushed
commits - `3521015` (the ladder, see 2b), `1e65d08`, `f656eb6`.

---

## 5. The Zaal tap list

Short, and in order. Everything above is blocked on the first item.

1. **OpenRouter top-up, roughly $5-10.** The scope note's finding 1 decision box
   is still unticked: `[ ] top up  [ ] free models  [ ] stay dark`. This is a
   money tap, not code. It unblocks the daily cast **and** the mention listener.
   Immediately after, read `~/zol/last-failure.json` to confirm the error actually
   cleared rather than assuming it (see 2a).

2. **Pi access for the deploy.** Either start Tailscale on this mac so the work can
   be done directly, or Zaal runs the pull and the `tmux kill-session -t zol`
   himself. Nothing in section 3 ships without one of these.

3. **Sign off on ZOL answering you.** Narrowing the fid 19640 guard is a
   deliberate behavior change: ZOL starts drafting replies to Zaal's tags. Output
   stays approval-gated, so nothing posts unreviewed, but it is his rule being
   reversed and it should be his call.

4. **Pick which ladder survives.** The Pi's `zao/zol-rate-limit` versus local
   `3521015`. Needs a diff and a decision before any Pi pull, and the 2-posts-per-4h
   cap must not be lost in the merge (see 2b).

5. **Standing, not blocking:** retire `repor`/`seor`/`ytr` from `start-fleet.sh`
   unless a consumer is named (scope note finding 2), and the branch-and-PR hygiene
   in finding 4. Neither gates the tag path.
