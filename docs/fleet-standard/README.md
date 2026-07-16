# Fleet Standard v0.1

A working design for running a small fleet of always-on, self-sustaining coding
loops (each a Claude Code session in its own tmux window, driven by a directive
file, opening PRs). Shared with Brandon (DreamLoops author) to harden into a
replicable standard. This is a **draft for review**, not a finished spec - the
open questions in section 6 are the honest weak points.

> **Redaction:** every host, user, token, chat id, and secret env value is
> replaced with a placeholder (`<VPS>`, `<USER>`, `<TOKEN>`, `<TRACKER_URL_VAR>`,
> `<TRACKER_KEY_VAR>`, `<GROUP_ID>`). Nothing here should let a reader reach our
> infrastructure. If you spot a leak, that is a bug - flag it.

## 0. The shape in one paragraph

N loops run in parallel, one per project. Each loop is a Claude Code session in a
named tmux window, started with `--dangerously-skip-permissions`, pointed at a
directive file it re-reads every turn ("Read ~/<name>-directive.md and continue
working it top to bottom. PR-only, self-sustaining."). A single **supervisor**
script runs on a short cron, walks every session, unsticks it (accepts trust
prompts, approves permission dialogs, relaunches a dead shell, re-prods an idle
loop), and publishes a fleet-status snapshot. Loops never merge to main; a human
merges. Knowledge that must survive context compaction is pushed to a knowledge
graph and to a `## STATE` block in the directive.

---

## 1. Supervisor design

The supervisor is one shell script on a `* * * * *`-ish cron. It is deliberately
dumb: it reads each pane's last lines and pattern-matches to decide one action.

### The script (redacted)

```bash
#!/bin/bash
# loops-keepalive.sh - fleet supervisor: approve/relaunch/prod every loop + publish status.
# session:workdir:directive triples
SESSIONS="loopA:/home/<USER>/<repo1>:loopA-directive.md \
loopB:/home/<USER>/<repo2>:loopB-directive.md \
loopC:/home/<USER>/<repo3>:loopC-directive.md"   # ... one per project

for spec in $SESSIONS; do
  S="${spec%%:*}"; rest="${spec#*:}"; DIR="${rest%%:*}"; DRV="${rest##*:}"

  # (a) RELAUNCH: create the session if it does not exist
  tmux has-session -t "$S" 2>/dev/null || { tmux new-session -d -s "$S" -c "$DIR" "bash -l"; sleep 1; }

  P=$(tmux capture-pane -t "$S" -p 2>/dev/null | tail -25)

  # (b) ACCEPT: the "trust this folder" screen blocks everything until answered
  if echo "$P" | grep -qE "Yes, I accept|Yes, I trust this folder"; then
    tmux send-keys -t "$S" "2"; sleep 1; tmux send-keys -t "$S" Enter; continue
  fi

  # (c) APPROVE: a permission / "do you want to proceed" dialog
  if echo "$P" | grep -qiE "Do you want to proceed|1\. Yes"; then
    tmux send-keys -t "$S" "1"; sleep 1; tmux send-keys -t "$S" Enter; continue
  fi

  # (d) DISMISS: the feedback ("How is Claude doing") modal
  if echo "$P" | grep -q "How is Claude doing"; then tmux send-keys -t "$S" Escape; fi

  # (e) RELAUNCH into Claude: the pane is sitting at a bare shell prompt
  if echo "$P" | tail -3 | grep -qE '^\S*\$ ?$|<USER>@'; then
    tmux send-keys -t "$S" "cd $DIR && /home/<USER>/bin/claude --dangerously-skip-permissions"
    sleep 1; tmux send-keys -t "$S" Enter; continue
  fi

  # (f) PROD: the loop is alive but not actively working -> re-issue the directive
  if ! echo "$P" | grep -q "esc to interrupt"; then
    tmux send-keys -t "$S" "Read ~/$DRV and continue working it top to bottom. PR-only, self-sustaining."
    sleep 1; tmux send-keys -t "$S" Enter
  fi
done

# (g) PUBLISH: snapshot every pane's working/idle/dead state to JSON, then Supabase
#     (see section 4). Reads creds from an env file; never inlines them.
```

### Each behavior, and why

- **relaunch (a, e):** loops die (crash, `/exit`, machine reboot). (a) recreates a
  missing tmux session at a login shell; (e) notices a session that dropped back
  to a bare shell prompt and re-enters Claude Code. Two layers because a session
  can be alive with a dead Claude inside it.
- **accept (b):** Claude Code's first-run "trust this folder" screen halts the
  loop indefinitely. The supervisor selects the trust option and presses Enter.
- **approve (c):** even under `--dangerously-skip-permissions`, some dialogs
  appear; the supervisor picks "Yes". (This is a known authority-boundary risk -
  see section 6, lens 1.)
- **dismiss (d):** transient modals (feedback prompt) steal focus; Escape clears them.
- **prod (f):** the core keep-alive. If the pane does **not** show the "esc to
  interrupt" spinner, the loop is not mid-turn, so the supervisor re-sends the
  standing directive line to make it take the next item. If it IS working, the
  supervisor does nothing (never interrupts a live turn).
- **publish (g):** writes `/tmp/fleet-status.json` and upserts a Supabase row per
  loop so a dashboard/bot can show fleet health without touching the box.

### Known failure modes we actually hit

1. **Context-fill (~939k tokens).** A long-lived loop grows its context until it
   is compacted; approaching the window limit, output quality and instruction-
   following degrade *before* a hard failure. The supervisor cannot see this - the
   pane looks "working". Mitigation today is the compact protocol (section 2), but
   detection is manual. **Gap.**
2. **Typed-but-unsubmitted input.** `send-keys "<text>"` then a separate
   `send-keys Enter` is required because a single call sometimes leaves the text
   in the input box unsent. If Enter is dropped, the loop sits idle with a full
   prompt box and the supervisor re-types over it. We split the two calls with a
   `sleep 1`; still occasionally races.
3. **Parked vs stuck.** "idle" (no "esc to interrupt") means either *nothing to do*
   (correctly parked, waiting on a human gate) or *hung/looping on a bad state*.
   The supervisor treats both the same (re-prod), which spams a genuinely-parked
   loop and can push it to invent low-value work. We have no reliable signal to
   tell parked from stuck. **Gap.**
4. **PATH on fresh shells.** A brand-new `bash -l` may not have `~/bin` or the node
   runtime on PATH, so `claude` / status tooling fail silently. Mitigation:
   the supervisor calls Claude by **absolute path** (`/home/<USER>/bin/claude`),
   and loops call helper scripts by absolute path too.
5. **Trust-folder screen.** Covered by (b) - but worth calling out because before
   we handled it, every fresh session hung on it forever.

---

## 2. Compact protocol

Verbatim from our directive (identical text ships in every loop's directive):

> **COMPACT PROTOCOL - context is disposable, knowledge is NOT.**
> Your conversation WILL be compacted/cleared - anything not persisted is lost.
> 1. On COMPLETING each work item: push ONE knowledge-graph episode:
>    `name=loop:<session>:<item-slug>`, body = 2-4 sentences: what you did, the key
>    decision/lesson, the PR/doc link. Best-effort - never block on it.
> 2. BEFORE any /clear or when context feels heavy: write a session-summary episode
>    (what is mid-flight, what the next session must know) + append a 3-line
>    `## STATE` block to your directive file (overwrite the prior STATE).
> 3. LESSONS go to the directive file (`## LESSONS`, append) - operating knowledge
>    lives in files, not chat history.
> This makes any future you resume from graph + directive + board with zero loss.

**Why.** A loop's memory is its context window, which is periodically summarized
or cleared. Treat context as a scratchpad that will be wiped, and write anything
that must outlive the turn to durable stores: the knowledge graph (searchable
across all loops and future sessions), the directive `## STATE` (the fast
resume-here pointer), and the board (the work queue). The test: *if this session
were cleared right now, could a fresh session pick up with no loss from
graph + directive + board alone?* If not, something important is still only in
chat and must be persisted.

---

## 3. Directive structure

Every loop is governed by one markdown directive it re-reads each turn. The
anatomy that has worked:

| Section | Purpose |
|---|---|
| **Identity + rules** (top) | Who this loop is; the non-negotiables (PR-only, never main, one item at a time, gated actions STOP + ping a human, self-sustain if the orchestrator is offline). |
| **North star** | The 1-2 goals every work choice is weighed against. Prevents drift into low-value busywork. |
| **Queue** | The ordered backlog. May defer to an external board as the real queue. |
| **STATE** (overwritten) | 3 lines: what is mid-flight + what the next session must know. The resume pointer. |
| **LESSONS** (appended) | Operating lessons learned online, so mistakes are not repeated after a context wipe. |
| **Self-improvement** | A cadence (every ~N items) to self-retro and PR improvements to the directive itself. |

### Template

```markdown
# <loop-name> directive (tmux: <session>, workdir: /home/<USER>/<repo>)
You are the <loop-name> loop. PR-only, never push main, one item at a time,
status one-liners to <STATUS_CHANNEL>, gated actions (deploy/keys/outbound/
spend/on-chain) STOP + "DECISION NEEDED". Self-sustain even if the orchestrator
is offline.

## THE NORTH STAR (triage lens)
1. <goal 1>.  2. <goal 2>.

## COMPACT PROTOCOL
Per completed item: one graph episode (what/decision/link). Before /clear:
session-summary episode + 3-line ## STATE here. Lessons -> ## LESSONS here.

## STANDING SELF-IMPROVEMENT
Self-retro every ~10 items; PR directive changes; board fleet improvements.

## Queue
(The orchestrator or a human appends work here, or this defers to the board.)

## STATE
(overwritten each compaction: mid-flight item, next-session must-know, blockers)

## LESSONS
(appended: durable operating lessons)
```

### One real example (redacted)

```markdown
# coc loop directive (tmux: coc, workdir: /home/<USER>/<repo>)
You are the coc loop. PR-only, never push main, one item at a time, status
one-liners to <STATUS_CHANNEL>, gated actions STOP + "DECISION NEEDED".
Self-sustain even if the orchestrator is offline.

## THE NORTH STAR (triage lens)
1. The ZAO = THE case study of a successful DAO. 2. ZAO IP = a staple in onchain
   art, music and culture.

## COMPACT PROTOCOL
Per completed item: one graph episode (what/decision/link). Before /clear:
session-summary episode + 3-line ## STATE here. Lessons -> ## LESSONS here.

## STANDING SELF-IMPROVEMENT
Self-retro every ~10 items; PR directive changes; board fleet improvements.

## Queue (event #7 is FRIDAY - everything serves that)
1. Pilot readiness audit: verify the metrics endpoint captures what we need on
   the night; write the show-night runbook. Surface owner-side blockers loudly
   (a broken upload key + an env flip) - ping the status channel daily until done.
2. Post-show capture plan: where the numbers land + the retro doc template.
3. General repo health: open PRs, broken anything, quick wins - PR-only.
```

---

## 4. Fleet status

### `/tmp/fleet-status.json` sample (redacted)

```json
{
  "updated": "2026-07-16T23:36:04Z",
  "loops": [
    {"session": "loopA", "state": "idle",    "last": "<USER>@<VPS>:~/<repo1>$"},
    {"session": "loopB", "state": "idle",    "last": "<USER>@<VPS>:~/<repo2>$"},
    {"session": "loopC", "state": "working", "last": "  bypass permissions on . esc to interrupt"},
    {"session": "loopD", "state": "working", "last": ""}
  ]
}
```

`state` is derived purely from the pane: `working` if the "esc to interrupt"
spinner is present, else `idle`, else `dead` if the tmux session is missing.
`last` is the last non-blank pane line, truncated (~110 chars).

### Supabase `fleet_status` table

Upserted on `session` (one row per loop):

| column | type | notes |
|---|---|---|
| `session` | text (PK / on_conflict) | loop name |
| `state` | text | working / idle / dead |
| `last_line` | text | truncated last pane line |
| `updated_at` | timestamptz | supervisor run time |

Upsert call shape (creds read from an env file, never inlined):

```
POST <TRACKER_URL_VAR>/rest/v1/fleet_status?on_conflict=session
  apikey: <TRACKER_KEY_VAR>
  Authorization: Bearer <TRACKER_KEY_VAR>
  Prefer: resolution=merge-duplicates
  body: [{session, state, last_line, updated_at}, ...]
```

### Edge-triggered alert

The supervisor keeps the previous snapshot (`/tmp/fleet-prev.json`) and diffs
states. Only on a **change** (`working -> idle`, `idle -> dead`, etc.) does it emit
one alert line to the status channel:

```
FLEET: loopB: working -> dead, loopC: idle -> working
```

Edge-triggered (not level) so a healthy fleet is silent and only transitions
page a human. This is the single cheapest, highest-signal piece of the whole
design.

---

## 5. One complete handoff example (EXAMPLE - not live data)

**(a) Item-completion episode** (pushed on finishing a work item):

```json
{
  "name": "loop:2026-07-16:fix-deadline-parser",
  "body": "Fixed a false-positive in the bounty deadline parser: it keyed only on the word 'deadline' then grabbed any date as a fallback, so an event kickoff date got read as the submission deadline. Now a date only counts when it sits right after a deadline keyword (deadline/closes/due/ends/submit by). Added a network-free selftest, 7/7. PR: <repo>#30."
}
```

**(b) Pre-clear session-summary episode** (pushed before a compaction/clear):

```json
{
  "name": "loop:2026-07-16:session-summary",
  "body": "Shipped 12 PRs this session, mostly hardening the submission pipeline (two deadline parsers + leaderboard pagination) plus two design specs. MID-FLIGHT: nothing half-done; all PRs verified + pushed, all clones cleaned. NEXT SESSION MUST KNOW: one urgent runtime PR (#<n>) fixes a syntax error that crashes a bot on restart - flag the human to merge it first. A second writer was observed committing in the shared clone - watch for it."
}
```

**(c) Directive `## STATE` block** (overwrites prior STATE in the directive file):

```markdown
## STATE (2026-07-16 23:40)
Mid-flight: none - queue worked to genuine blockage; all work PR'd + verified.
Next: merge urgent boot-fix PR #<n> before the bot restarts; then runtime PRs.
Watch: a concurrent writer is driving the shared clone (isolate via worktrees).
```

Together these three let a fresh session reconstruct the state with no chat
history: the graph gives the "why + links", the STATE block gives the "resume
here", the board gives the "what's next".

---

## 6. Open hardening questions (honest gaps)

Mapped to Brandon's 10 review lenses. These are where the current design is
**weak**, stated plainly.

1. **Authority boundaries.** Enforced by *prompt convention*, not technical
   control: the directive says "gated actions STOP", and loops run with
   `--dangerously-skip-permissions`. Nothing technically prevents a loop from
   running a deploy/spend/on-chain action - it just is told not to. We want a
   hard allow/deny layer (tool-level policy) independent of the prompt.
2. **Evidence gates.** "Done" is self-reported. A loop runs typecheck / build /
   tests / selftests and reports green, but no *independent* verifier re-checks
   before a human sees the PR. A loop could claim green it did not earn. Want:
   CI as the source of truth, and a loop that cannot mark done without a CI
   receipt.
3. **Replay protection.** None formal. Loops re-read the same directive every
   turn; idempotency is achieved by *checking existing PRs/board state* before
   acting, not by replay-safe task tokens. A re-fire after a crash can redo or
   double-open work (we have seen duplicate/mispointed PRs).
4. **Task leasing.** No lease. The board does not lock a task to one loop, so two
   loops (or a loop + the orchestrator) can grab the same item - we hit exactly
   this as a shared-clone write collision. Want: atomic claim/lease with TTL.
5. **Receipt provenance.** Actions leave git commits (author + co-author trailer)
   and graph episodes, but there is no signed, tamper-evident receipt chain
   linking directive -> decision -> PR -> merge. Provenance is reconstructable,
   not cryptographic.
6. **Checkpoints.** The compact protocol (episode + STATE block) is the checkpoint,
   but it is *best-effort and manual* - a loop that dies mid-item before writing
   one loses that item's state. Want: automatic checkpointing on item boundaries.
7. **Rollback beyond boot.** We boot-verify bot code before claiming done, and
   "rollback" today is "don't merge" / `git revert` / close the PR. There is no
   automated rollback of a *merged* bad change beyond a human reverting. State
   changes outside git (data writes) have no rollback at all.
8. **Supervisor split-brain.** The supervisor is a single cron with no leader
   election. Two supervisors (or two pollers of one bot token) cause double-input
   / double-poll (a real 409 class of bug). Want: a lock/lease so exactly one
   supervisor is authoritative.
9. **Lineage.** git history + graph episodes give partial lineage, but there is no
   first-class task -> attempt -> artifact -> outcome graph. Answering "which loop,
   from which directive version, produced this merged change, and was it verified"
   requires manual cross-referencing.
10. **Formal DreamLoop conversion.** Loops today are prompt-driven tmux sessions,
    not formal state machines. Converting a loop into a bounded DreamLoop (explicit
    states, transitions, evidence per transition) is the aspiration and the reason
    for this review - it is not done. A board task tracks it.

### The honest summary

This design is strong on **liveness** (the fleet keeps working, unattended,
across crashes and context wipes) and on **human-gated safety by convention**
(PR-only, never main, gated-actions-stop). It is weak on **hard enforcement**
(1, 2, 8), **concurrency safety** (3, 4, 8), and **provenance/rollback** (5, 7, 9).
The DreamLoop conversion (10) is the path that would address most of these at
once by making each transition explicit and evidence-gated. That is the
conversation we want to have.
