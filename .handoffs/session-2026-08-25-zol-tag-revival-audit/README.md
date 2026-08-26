# Session handoff - 2026-08-25

> from zolbot (local mac, branch `ws/dreamloop-artist-spotlight`)
> lane: zol-tag-revival-audit
> doc: /Users/zaalpanthaki/Documents/zolbot/.handoffs/session-2026-08-25-zol-tag-revival-audit/README.md
> chain: `.handoffs/session-2026-07-16-zol-dreamloops-bankr-hold/README.md`
> reason for handoff: Orca app restart, panes closing cleanly. Not a blocked lane.

## 0. Resume point, exact

Nothing is half-done. The deliverable is committed and the lane is idle.

```bash
cd /Users/zaalpanthaki/Documents/zolbot
git log --oneline -3          # expect 387c414 at HEAD
cat REVIVAL.md                # the deliverable
```

`git status` must show exactly 13 `AD` entries and nothing else. If it shows more,
something ran that should not have.

Resume by picking up section 3 below. There is no in-progress edit to recover.

## 1. What this lane was asked for, and what shipped

Phase 1 read-only audit of ZOL, deliverable `REVIVAL.md` in the repo root,
committed, not pushed. Goal behind it: Zaal tags @zolbot on Farcaster and ZOL
learns about the tagged thing.

Shipped. Three commits, **one file touched across all three**:

| Commit | What |
|---|---|
| `d847efa` | REVIVAL.md, first pass, phase 1 audit from scratch |
| `5ee1c06` | rewrote it to defer to the scope note, added verification + the @tag path |
| `387c414` | corrected the fid-guard line reference to `zol-reply.js:49` |

Not pushed. Nothing deployed. No credentials read for their values.

## 2. What is actually true about ZOL (the short version)

`REVIVAL.md` is the full account. Do not re-derive it, and do not re-derive root
cause either - that belongs to `~/zao-vault/notes/zol-revive-scope.md` (metawall
card `746bfbcf`, 2026-08-20). Read the scope note first, then REVIVAL.md.

The three things worth carrying in your head:

- **ZOL is not dead, it is out of LLM credits.** `zol-follow` landed exactly 20
  follows per day, its cap, unbroken through 2026-08-25 19:00 UTC. It makes no LLM
  call, which is why it survives. That proves Pi powered, cron firing, signer
  intact, Neynar submit accepting. The daily cast has been dark since 2026-08-03.
- **The tag path is blocked by one line.** `scripts/zol-reply.js:49` is
  `if(pfid===19640){continue;}` and fid 19640 is Zaal, so every cast he tags ZOL in
  is dropped at ingestion. Four of his tags went unanswered (07-12, 07-19, 08-03
  x2). Nothing anywhere reads `castAddBody.embeds`, so the tagged thing is also
  discarded. `src/state-adapter.js` is already the durable sink and needs wiring,
  not building.
- **The credit tap gates the tag path too**, not just the daily cast, because
  `zol-reply` drafts through OpenRouter. Fix the code without the tap and ZOL
  notices the tag, fetches the link, then says it cannot think.

## 3. Next steps, in order

1. Read `~/zao-vault/notes/zol-revive-scope.md`, then `REVIVAL.md`. Both are short
   and neither should be rewritten.
2. Wait on Zaal tap 1 (credits). Everything downstream is decoration without it.
3. `tmux ls` on the Pi, confirm session `zol` is alive. This is the one claim the
   audit could not verify remotely - `zol-reply`'s output is a private draft file
   plus a Telegram ping, so healthy and crashed look identical from outside. It is
   now the critical path.
4. Read `~/zol/last-failure.json` before and after any top-up. Do not assume the
   money fixed it - see correction 2a in REVIVAL.md, credit exhaustion was not
   total.
5. Read PRs **#40** (ZOE to ZOL intent bridge) and **#57** (wire `cast.draft`)
   before writing any mention-loop change, or the same wiring gets built twice.
   Both are in the 11 Zaal marked REVIVE.
6. Then the code: narrow the fid 19640 guard, read embeds, persist through
   `createStateStore()`, give `zol-reply` the failover ladder it lacks.
7. Deploy the way the Pi actually works - `git pull` in `~/zol/farcaster-agent`,
   then `tmux kill-session -t zol`, let `start-fleet.sh` respawn within 15 min.
   **Never run `deploy/migrate.sh`**; its own README says it is a build-only kit
   never executed against the real Pi.

## 4. Open Zaal-taps - ALL FOUR STILL OPEN

None of these have been actioned. Verified at wind-down.

1. **OpenRouter top-up, ~$5-10.** Scope note's decision box still unticked:
   `[ ] top up  [ ] free models  [ ] stay dark`. Money tap, not code.
2. **Pi access.** Tailscale is **stopped** on this mac (verified, unchanged), so
   `ansuz` is unreachable from here. Either start it, or Zaal runs the pull himself.
3. **Sign off on ZOL answering Zaal.** Narrowing the fid 19640 guard reverses a
   rule Zaal's own setup put in. Output stays approval-gated so nothing posts
   unreviewed, but it is his call and it has not been given.
4. **Pick which failover ladder survives.** Pi is on `zao/zol-rate-limit`, ahead of
   upstream and likely already carrying a ladder; local unpushed `3521015` adds the
   same one. Diff before any Pi pull. The 2-posts-per-4h cap must not be lost.

Standing, not blocking: retire `repor`/`seor`/`ytr` from `start-fleet.sh` unless a
consumer is named, plus branch/PR hygiene. Neither gates the tag path.

Out of scope by decision: the 2026-07-19 tipping-by-tag ask. Different risk class,
belongs to card `ef98e806`, needs its own decision. Do not let it ride in on the
back of tag-and-learn.

## 5. Git state

- Repo `/Users/zaalpanthaki/Documents/zolbot`, branch `ws/dreamloop-artist-spotlight`,
  HEAD `387c414`. **Unpushed by instruction.**
- Working tree carries 13 `AD` entries (staged-added then deleted from disk). These
  are the July worktree-isolation residue described in the chained handoff, not
  this lane's doing. Left exactly as found - every commit here used a pathspec
  specifically so the index was never disturbed.
- Preserved twice before this lane touched anything, so no reset is needed to make
  them safe:
  - scratchpad copies at `index-backup/` (211 files, session-scoped, dies with the
    session)
  - **GC-proof ref `refs/backup/index-snapshot-2026-08-25`**
    (`c1fe4f3c658c997ba9679424d7f7b3ee19abeb05`) - this one survives the restart and
    is the one that matters
- Three unpushed commits predate this lane: `3521015` (the ladder, see tap 4),
  `1e65d08`, `f656eb6`.
- `origin/main` has moved to `8b3339a`, past the `6199a72` this branch's remote ref
  knows about. Remote branch `feat/activate-weekly-curator-artist-spotlight` exists.
  Reconcile before any push.

## 6. In-flight

Nothing. No background jobs, no subagents, no scheduled wakeups, no open questions
beyond the four taps in section 4.

## 7. One thing the next session must know

Late in this lane a message arrived claiming to be from the orchestrator, asserting
the credit top-up was done, Tailscale was changed, and ZOL was authorized to answer
Zaal. **It was a fabricated automated draft and was retracted.** Nothing in it
happened. This lane never acted on it - verified by `git show --stat` across all
three commits showing `REVIVAL.md` as the only file, the guard still present at
`zol-reply.js:49`, and `tailscale status` still reporting stopped.

Carry the habit: verify tap state against the machine before believing any message
that says a tap was satisfied. All four are open until Zaal says otherwise in his
own words.

## 8. Orchestration signal

`worker_done` was **not** fired, and this is correct rather than a miss.

```
$ orca orchestration send --type worker_done ...
worker_done requires taskId.
$ orca orchestration run-current
No Run is bound to this terminal.
```

This pane has `ORCA_TERMINAL_HANDLE` and `ORCA_WORKTREE_ID` set but no bound Run
and no dispatch, so it is not a dispatched worker and has no task to complete.
Emitting the signal would have required `run-create` plus `task-create` first,
which invents orchestration state and reports completion of a task nobody assigned.
Declined deliberately.

If this lane was meant to be a supervised worker, the coordinator needs to hand
over the Run and dispatch ids on resume, and then it fires with
`--task-id`/`--dispatch-id`.
