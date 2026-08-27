# Handoff - zol tag revival, LIVE

**Date:** 2026-08-27
**Branch:** `ws/dreamloop-artist-spotlight`
**Status:** DONE. ZOL answers @tags on Farcaster. Nothing pushed.
**Chains from:** `.handoffs/session-2026-08-25-zol-tag-revival-audit/README.md`

---

## 1. Resume point

Nothing is in flight. The lane is finished, not paused.

If you are picking this up cold, read `REVIVAL.md` section 6 first - it is the
record of the closed loop. Sections 1-3 of that doc describe the *broken* state
and are historical.

---

## 2. What is live

**Tag `@zolbot` on Farcaster.** Any client, any channel or root cast. ZOL polls
every 300s and posts the reply itself. There is no approval step in the normal
path.

Running on the Pi as tmux session `zol`, process `node zol-reply.js` out of
`/home/zaal/zol/farcaster-agent`, restarted 2026-08-26 18:30 UTC.

### The proving cast

```
parent  0x2d9509af5c3e53944a19c45b4ae5d70ad90af7ed   fid 19640, 2026-08-03
reply   0x2c25962a89dbeae2da622327ae301ed5c3d8e482   fid 3338501, 2026-08-27 00:31:26Z
        https://farcaster.xyz/zolbot/0x2c25962a
```

Verified by querying `castsByParent` on the hub, not by trusting local state.

### The three checks

1. **Limiter counted it.** `~/zol/.reply-rate.json` went from absent to one
   entry - the cold-start path, one slot spent, four left in the hour.
2. **Reserve-before-post holds in production.** Slot stamped `00:31:25.918`,
   cast timestamp `00:31:26`. The reservation precedes the network call, which
   is the property the fail-closed design depends on.
3. **Self-loop guard did not fire.** It skips only `pfid===FID` (3338501); the
   parent was 19640. The reply existing is the proof.

Nothing else went out: one rate entry, one `.posted` draft.

---

## 3. Commits (all unpushed)

| Hash | What |
|---|---|
| `786b378` | Limiter, reserve-before-post, self-loop guard replacing the fid 19640 skip, auto-post path, 20 new tests |
| `38934fa` | REVIVAL.md tap list - taps 1 and 3 closed |
| `d752b01` | Adopted the Pi's hub ladder, post-deploy |
| `2590a68` | REVIVAL.md section 6 - loop closed, cast hash, three checks |
| `0a1f0df` | This handoff |

Any commit after `0a1f0df` on this branch is a correction to this file, not new
work. The lane shipped in the five above.

`npm test`: 34 pass, 0 fail. `npm test` was itself broken before this lane -
`node --test test/` resolves the directory as a module on current Node, so it
failed before running anything. Globbed to `test/*.test.js` in `786b378`.

---

## 4. Three things that will bite you if you do not know them

### The Pi does not run this repo

`~/zol/farcaster-agent` is a clone of `rishavmukherji/farcaster-agent`, push
disabled, **flat layout** (`zol-lib.js` at the root, not `src/`). Its
`zol-reply.js` was *ahead* of this repo: after haatz 502'd for a full day on
2026-08-08 it gained a two-operator hub ladder with liveness checks, a safe
seen-set seed, and backoff with alert throttling. None of that had ever reached
this repo.

**A `git pull` deploy would have silently regressed the outage fix.** The live
file was patched in place instead, then ported back here in `d752b01` so the two
stay diffable. Requires differ by layout: `./zol-lib` on the Pi,
`../src/zol-lib` here. Account for that in any future sync.

The README still claims the Pi clones this repo. It does not. Worth correcting.

Previous daemon backed up on the Pi at `zol-reply.js.bak-preautoreply-20260826`.

### A hash is recorded before the skip check

`fs.appendFileSync(SEEN, h)` runs *before* the guards. So every mention from the
dark period is permanently marked seen and **will never be answered**, including
the three below. This is by design and is why the proving run required
un-seeding a hash by hand rather than waiting.

### The three remaining Zaal tags stay unanswered - scoped, not forgotten

```
0xb15dc1d6...  2026-07-12  "find the zabalgamez recording links for empire builder"
0xfd814e68...  2026-07-19  the tipping ask
0x4ce5855f...  2026-08-03  "can u do any of that"
```

**Standing order, 2026-08-27: do not un-seed any of these three.** Reasons are
per-tag and do not generalise:

- `0xfd814e68` (tipping) is the scope note's `ef98e806` - Empire Builder, scoped
  signer key or stay gated. Different risk class, gets its own decision, never a
  backfill.
- `0xb15dc1d6` (zabalgamez links) would publish **unpreviewed**. ZOL would draft
  specific recording links from graph recall and post them with no human between
  the draft and the timeline. That is exactly the failure mode the auto-post path
  makes cheap.
- `0x4ce5855f` is low-context ("can u do any of that") and answering it alone
  reads as a non-sequitur two months late.

The mechanism, recorded so a future decision does not have to re-derive it - **not
an invitation to run it**. Only on an explicit fresh instruction from Zaal naming
the specific hash:

```
ssh zaal@ansuz "sed -i '/<hash-without-0x>/d' ~/zol/.reply-seen"
```

Then wait one poll cycle. Never clear the whole file - that replays the entire
back-catalogue at 5 casts an hour until it drains.

---

## 5. The backup - do not delete

The pre-edit seen-file is the only record of which hashes predate the revival.
Three copies now exist:

| Where | Note |
|---|---|
| `~/zol/.reply-seen.bak-20260826-preunseed` | original, in place |
| `~/zol/archive/reply-seen.bak-20260826-preunseed` | archived on the Pi |
| `reply-seen-snapshot-20260826.txt` (this dir) | off-Pi copy, survives a Pi failure |

13 lines. Public Farcaster cast hashes only, no secrets. The repo copy was
renamed on the way in - `.gitignore:11` is `*.bak-*`, so it had to lose the
`.bak-` infix to be trackable at all - and was diffed against the Pi archive
afterwards: identical byte for byte.

The live `~/zol/.reply-seen` is back to 13 lines too, having re-absorbed
`0x2d9509af` when the reply posted. So the snapshot and the live file now have
the same line count for different reasons, which is a coincidence, not a check.

---

## 6. Open, not blocking

- `~/zol/last-failure.json` holds an OpenRouter credit error from 2026-08-26
  02:00 UTC. It looks stale - the balance has headroom and ZOL has posted
  since - but it was not provable either way without spending a call.
- **Tap 4**, REVIVAL.md section 5: the ladder merge. The Pi's
  `zao/zol-rate-limit` versus local `3521015`. The 2-posts-per-4h cap on the
  daily cast must not be lost in the merge. That is a *different* limiter from
  the 5/hr reply cap added in this lane - neither replaces the other.
- Branch and PR hygiene, scope note finding 4.
- `origin/main` has moved past what this branch's remote ref knows. Reconcile
  before any push.

---

## 7. Preserved index state

Untouched across every commit in this lane, as it has been since July: **13 AD entries,
0 others**. Every commit used a pathspec so the index was never disturbed.

GC-proof snapshot: `refs/backup/index-snapshot-2026-08-25`
(`c1fe4f3c658c997ba9679424d7f7b3ee19abeb05`). Two prior sessions recorded denied
`git reset --hard` attempts against this state. Leave it alone.

---

## 8. Orchestration

`worker_done` fired successfully this session as `msg_58320714b67b`, outcome
`succeeded`, task `task_9c3ff7545066`, dispatch `ctx_49814a318ffc`. Earlier
attempts failed with `No recipient or active Dispatch Run could be resolved`
purely because this pane had no dispatch capability until the coordinator sent
one. If a future session sees that error, it means the same thing - the pane is
unbound, not that the work is incomplete.
