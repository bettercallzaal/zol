# Fleet Standard v0.1 — Operating Constitution and Certification Package

> **STATUS: DRAFT — under review. Not production-certified.**
> All host names, usernames, tokens, chat IDs, wallet addresses, and secret
> values are replaced with `<PLACEHOLDER>` format. If you spot a real value,
> that is a bug — flag it immediately.
>
> **Acceptance criterion:** another team must be able to take this bundle,
> mint a fleet, run the conformance harness, and PROVE that its agents are
> bounded, recoverable, auditable, and unable to exceed their assigned
> authority. If the harness cannot prove that end to end, the bundle is not
> done.

---

## Table of Contents

1. [Fleet Invariants](#1-fleet-invariants)
2. [Authority Matrix](#2-authority-matrix)
3. [Directive Schema](#3-directive-schema)
4. [Loop Lifecycle and State-Transition Rules](#4-loop-lifecycle-and-state-transition-rules)
5. [Evidence and Receipt Requirements](#5-evidence-and-receipt-requirements)
6. [Task Leasing and Replay Protection](#6-task-leasing-and-replay-protection)
7. [Memory and Succession Protocol](#7-memory-and-succession-protocol)
8. [Approval and Escalation Policy](#8-approval-and-escalation-policy)
9. [Deployment and Rollback Rules](#9-deployment-and-rollback-rules)
10. [Failure-Mode Tests](#10-failure-mode-tests)
11. [Redaction and Secret-Handling Rules](#11-redaction-and-secret-handling-rules)
12. [Versioning and Compatibility Policy](#12-versioning-and-compatibility-policy)
13. [Conformance Checklist and Executable Harness](#13-conformance-checklist-and-executable-harness)
14. [Supervisor Design Reference](#14-supervisor-design-reference)
15. [Compact Protocol Reference](#15-compact-protocol-reference)
16. [Directive Template Reference](#16-directive-template-reference)
17. [Fleet Status Reference](#17-fleet-status-reference)
18. [Handoff Example](#18-handoff-example)

---

## 1. Fleet Invariants

These rules are UNCONDITIONAL. No directive, capsule configuration, or
operator instruction may override them. Any implementation that violates an
invariant fails the conformance check.

### 1.1 Git and Deployment Invariants

**INV-1.** No agent may push to `main` or `master` directly. All changes
reach the default branch only through a reviewed, human-merged pull request.

**INV-2.** No agent may trigger a deployment to a production host
(`deployment.production.write`) without a passing human approval that is
bound to that specific deployment action, the normalized input digest, and
the requesting actor.

**INV-3.** No agent may modify its own running code without Zaal's approval
and a PR merge cycle. Self-modification of production is permanently blocked.

### 1.2 Secrets and Privacy Invariants

**INV-4.** No agent may expose secrets (private keys, API tokens, wallet
mnemonics, bearer tokens, chat IDs, database passwords) in Git commits, log
output, fixture files, test snapshots, terminal pane captures, screenshots,
Proof Drop bundles, or any artifact that crosses a trust boundary.

**INV-5.** Secrets are detected by field context and actual credential
formats, not by length heuristics. SHA-256 content hashes, commit SHAs,
idempotency keys, and receipt hashes are NOT secrets and must not be
redacted from receipts.

**INV-6.** The signer's Ed25519 private key and the wallet's ECDSA key are
never passed to any subprocess, RPC endpoint, LLM model call, or log line.
`signer.change` is permanently blocked for all agents.

### 1.3 Posting and Communication Invariants

**INV-7.** No agent may post publicly (Farcaster cast, Telegram message,
social media write) without first passing through the human approval gate.
For ZOL, this gate is the Telegram flow via `<TELEGRAM_BOT_NAME>`. Automated
posting of unreviewed content is permanently blocked
(`public.publish.without_approval`).

**INV-8.** No agent may spend funds, transfer tokens, tip, mint, or sign a
spend transaction (`fund.transfer`, `wallet.sign`).

### 1.4 Receipt and Audit Invariants

**INV-9.** Every consequential action (any action classified as
`live_guarded_action` or `production_write` in the permission tier) produces
an immutable receipt record before the action's side effects are considered
committed. A receipt write failure for a consequential action is not swallowed
— the action fails closed.

**INV-10.** Every receipt includes a SHA-256 hash of its content, a link to
the previous receipt (`previousReceiptId`, `previousReceiptHash`), and
sufficient evidence to reconstruct the causal chain:
`directive → task → approval → action → outcome`.

**INV-11.** Receipt chains must be verifiable. A receipt with a broken or
missing chain link fails the conformance check.

### 1.5 Telemetry Invariants

**INV-12.** All telemetry is categorical: counters, state labels, durations,
error codes. Raw terminal pane content, prompt text, LLM completions, memory
entries, and message bodies are NEVER transmitted in telemetry.

**INV-13.** Fleet status snapshots (`fleet-status.json`, Supabase upserts)
contain only `session`, `state` (one of the enumerated loop states), a
truncated `last_line` of no more than 110 characters, and `updated_at`.

### 1.6 Supervisor Invariants

**INV-14.** Exactly one supervisor instance is authoritative for each host at
any given time. A same-host lock (flock or equivalent) prevents two supervisor
processes from running concurrently on the same machine. If the lock cannot be
acquired, the incoming supervisor exits cleanly without touching any loop.

**INV-15.** The supervisor holds a durable leader lease (persisted on disk with
a fencing epoch counter). Each lease renewal increments the epoch. A supervisor
that loses the lease due to a restart must re-acquire it and increment the
epoch before issuing any commands to loops.

**INV-16.** The supervisor does NOT send terminal pane content to any external
service. It reads pane lines only to pattern-match state (working / idle / dead)
for its own decision logic.

---

## 2. Authority Matrix

The authority matrix defines which actors may authorize which action classes.
Every action that touches external systems, public channels, signers, wallets,
or production infrastructure must be traced to a row in this matrix.

### 2.1 Permission Tiers (from DreamLoops runtime contracts)

| Tier | Label | Description |
|------|-------|-------------|
| T1 | `read_only` | Read local state, receipts, memory. No writes. |
| T2 | `local_draft_write` | Write to local draft store, memory, receipts. No external effects. |
| T3 | `artifact_draft_write` | Build and version artifacts locally. No delivery. |
| T4 | `private_branch_write_candidate` | Open a PR on a non-main branch. Human must merge. |
| T5 | `live_guarded_action` | Actions with external effects (e.g., read public API, send to private channel). Requires prior approval. |
| T6 | `production_write` | Deploy, post publicly, sign, spend. Requires explicit human approval at runtime. |

### 2.2 Action Authority Table

| Action Class | T1 | T2 | T3 | T4 | T5 | T6 | Required Authorizer |
|---|:---:|:---:|:---:|:---:|:---:|:---:|---|
| `memory.read` | Y | Y | Y | Y | Y | Y | — (always permitted) |
| `state.local.read` | Y | Y | Y | Y | Y | Y | — |
| `state.local.write` | N | Y | Y | Y | Y | Y | Capsule `allowed` list |
| `receipt.local.write` | N | Y | Y | Y | Y | Y | Capsule `allowed` list |
| `task.read` | Y | Y | Y | Y | Y | Y | — |
| `task.capture` | N | Y | Y | Y | Y | Y | Capsule `allowed` list |
| `artifact.local.write` | N | N | Y | Y | Y | Y | Capsule `allowed` list |
| `approval.request` | N | N | N | Y | Y | Y | Capsule `allowed` list |
| `source.public.read` | N | N | N | N | Y | Y | Capsule `allowed` list + rate limit |
| `farcaster.reply` | N | N | N | N | Y | Y | Approval gate (Telegram) |
| `farcaster.cast` | N | N | N | N | N | Y | Approval gate (Telegram) + human review |
| `deployment.production.write` | N | N | N | N | N | Y | Zaal explicit approval + receipt |
| `wallet.sign` | N | N | N | N | N | — | BLOCKED permanently |
| `fund.transfer` | N | N | N | N | N | — | BLOCKED permanently |
| `signer.change` | N | N | N | N | N | — | BLOCKED permanently |
| `self.modify.live` | N | N | N | N | N | — | BLOCKED permanently |
| `public.publish.without_approval` | N | N | N | N | N | — | BLOCKED permanently |
| `secret.value.read` | N | N | N | N | N | — | BLOCKED permanently |

### 2.3 Capsule Permission Declaration Requirement

Every capsule MUST explicitly declare:
- `permissions.allowed`: exhaustive list of permitted action strings
- `permissions.blocked`: list of permanently blocked actions (must include at
  least `wallet.sign`, `deployment.production.write`, and `signer.change`)
- `resource_limits.max_wall_time_ms`
- `resource_limits.max_steps`
- `resource_limits.max_retries_per_step`

A capsule with overlapping `allowed` and `blocked` entries is invalid and must
be rejected at validation time.

---

## 3. Directive Schema

Every loop is governed by a markdown directive file that it re-reads each turn.
The directive is the authoritative source for that loop's identity, scope,
queue, current state, and operating lessons.

### 3.1 Required Sections

| Section | Required | Overwritten vs. Appended | Purpose |
|---------|----------|--------------------------|---------|
| Identity + rules | Yes | Static (manual edit only) | Who this loop is; the non-negotiables |
| North Star | Yes | Static | 1-2 goals every work choice is weighed against |
| Compact Protocol | Yes | Static | Knowledge persistence rules |
| Queue | Yes | Operator-managed | Ordered backlog of work items |
| STATE | Yes | Overwritten each compaction | 3-line resume pointer |
| LESSONS | Yes | Appended | Durable operating lessons |
| Self-improvement | Recommended | Static | Cadence for directive self-improvement PRs |

### 3.2 Required Rules (must appear verbatim or equivalent in identity section)

Every directive MUST include all of the following rules:

```
PR-only, never push main, one item at a time,
gated actions (deploy/keys/outbound/spend/on-chain/post) STOP + "DECISION NEEDED",
self-sustain even if the orchestrator is offline.
```

### 3.3 Directive File Naming Convention

```
~/<loop-name>-directive.md
```

Example: `~/zol-directive.md`, `~/coc-directive.md`

### 3.4 Template

```markdown
# <loop-name> directive (tmux: <SESSION>, workdir: /home/<USER>/<REPO>)
You are the <loop-name> loop. PR-only, never push main, one item at a time,
status one-liners to <STATUS_CHANNEL>, gated actions (deploy/keys/outbound/
spend/on-chain/post) STOP + "DECISION NEEDED". Self-sustain even if the
orchestrator is offline.

## THE NORTH STAR (triage lens)
1. <primary goal>. 2. <secondary goal>.

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

### 3.5 STATE Block Format

The STATE block must be exactly 3 lines, overwritten on each compaction:

```markdown
## STATE (<ISO_TIMESTAMP>)
Mid-flight: <item description or "none">
Next: <what the next session must do first>
Watch: <any active blockers or risks>
```

---

## 4. Loop Lifecycle and State-Transition Rules

### 4.1 Enumerated States

Every loop is in exactly one of the following states at any given time:

| State | Description |
|-------|-------------|
| `idle` | No active turn. Loop is alive, waiting for the supervisor to prod it or for a trigger event. |
| `triggered` | Supervisor has sent the directive prod. Loop has received the input but has not yet started processing. |
| `running` | Loop is actively processing (the "esc to interrupt" spinner is present). |
| `awaiting_approval` | Loop has submitted an approval request and is blocked waiting for a human decision. This is a legitimate pause, not a fault. |
| `blocked` | Loop cannot proceed due to a dependency it cannot resolve (missing human input, an upstream task incomplete, a resource unavailable). |
| `completed` | The current work item is done, evidence committed, receipt written. |
| `failed` | A step produced an error that exhausted retries and escalation options. The loop is alive but cannot complete the current item. |
| `dead` | The tmux session is missing or the loop process has exited. Requires supervisor restart action. |
| `unknown` | The supervisor cannot determine the loop's state from pane output. Treated conservatively as `blocked` — supervisor does NOT prod an unknown-state loop. |

### 4.2 State Transition Diagram

```
                 supervisor prods
       +---------+              +----------+
       |  idle   |  ----------> | triggered|
       +---------+              +----------+
            ^                       |
            |                       v (Claude starts turn)
       (item done,            +----------+
        receipt written)      | running  |
            |                 +----------+
            |                  /   |   \
            |       (approval  /   |    \ (unrecoverable
            |        needed)  /    |     \  error, retries
            |                v    |      v  exhausted)
       +---------+  +-----------+ |   +--------+
       |completed|  |awaiting_  | |   | failed |
       +---------+  |approval   | |   +--------+
                    +-----------+ |
                         |        | (dependency
                    (approval     |  missing)
                     received)    v
                         |    +--------+
                         +--> |blocked |
                              +--------+
                                   |
                           (human resolves)
                                   |
                              (back to idle)

        If tmux session missing -> dead
        If pane unreadable     -> unknown
```

### 4.3 Transition Rules

- `idle → triggered`: Only the supervisor may perform this transition, and
  only after confirming the loop is NOT in `running`, `awaiting_approval`, or
  `unknown` state.
- `triggered → running`: Automatic (loop begins its turn).
- `running → completed`: Loop writes evidence and receipt, then enters a resting
  state (bare shell or idle Claude). Supervisor detects via absence of "esc to
  interrupt".
- `running → awaiting_approval`: Loop calls `approval.request` and signals
  it is waiting (e.g., posts to the approval channel, updates task status).
- `running → failed`: All retry attempts exhausted; loop posts
  "DECISION NEEDED" with failure details to the status channel.
- `running → blocked`: Loop cannot proceed, reasons are documented in STATE.
- `awaiting_approval → running`: Human decision received via ApprovalBridge;
  loop resumes.
- `awaiting_approval → failed`: Approval timeout exceeded or approval denied.
- Any state → `dead`: Supervisor detects tmux session missing.
- Any state → `unknown`: Supervisor cannot read pane content reliably.
- `dead → idle`: Supervisor relaunches the session and re-prods the loop.
- `unknown → idle`: Supervisor waits one full supervisor cycle before
  re-classifying (never prods an unknown-state loop immediately).

### 4.4 Loop Lifecycle Requirements

Every loop definition (DreamLoop manifest) MUST declare:

1. **Entry conditions** (`trigger` field + `inputs` + precondition `checks`)
2. **Exit conditions** (`evidence_outputs` + `receipt_outputs` completing)
3. **Retry limits** (`limits.max_retries_per_step`, per-step `retry.max_attempts`)
4. **Escalation rules** (`failure_modes` list mapping fault types to escalation actions)
5. **Owner** (`owner` field — the capsule or agent ID responsible for this loop)

A loop missing any of these five fields is invalid and must be rejected by the
conformance harness.

### 4.5 Supervisor State-Observation Algorithm

```
for each session S in SESSIONS:
  if tmux has-session S fails:
    state[S] = "dead"; supervisor.relaunch(S); continue

  pane = tmux capture-pane -t S (last 25 lines)

  if pane is unreadable:
    state[S] = "unknown"; continue   # do NOT prod

  if "esc to interrupt" in pane:
    state[S] = "running"; continue   # do NOT interrupt

  if trust-prompt in pane:
    state[S] = "triggered"; supervisor.accept_trust(S); continue

  if permission-dialog in pane:
    state[S] = "triggered"; supervisor.accept_dialog(S); continue

  if "How is Claude doing" in pane:
    supervisor.dismiss_modal(S)
    # re-read state on next cycle

  if bare-shell-prompt in pane:
    state[S] = "idle"; supervisor.relaunch_claude(S); continue

  # Loop is alive but not running -> prod it
  state[S] = "idle"
  supervisor.prod(S)
```

---

## 5. Evidence and Receipt Requirements

### 5.1 Receipt Record Schema

See `schemas/receipt.schema.json` for the machine-readable definition.

Every receipt record MUST contain:

| Field | Type | Description |
|-------|------|-------------|
| `receiptId` | string | Unique receipt identifier (UUID or `rcpt-<hash>`) |
| `loopId` | string | The DreamLoop or loop session that produced this action |
| `runId` | string | Unique identifier for this execution run |
| `agentId` | string | Agent identity (e.g., `zolbot`) |
| `action` | string | Action string from the authority matrix |
| `status` | `"success"` \| `"failure"` \| `"pending"` | Outcome |
| `sha256` | string | SHA-256 hash of the receipt content (`sha256:<hex>`) |
| `previousReceiptId` | string \| null | Chain link to prior receipt |
| `previousReceiptHash` | string \| null | SHA-256 of the prior receipt record |
| `evidence` | object | Structured evidence (see 5.2) |
| `createdAt` | string | ISO 8601 timestamp |

Optional but recommended:

| Field | Type | Description |
|-------|------|-------------|
| `taskId` | string | Associated WorkRouter task packet |
| `attemptId` | string | Attempt identifier (for lease binding) |
| `fencingEpoch` | integer | Supervisor fencing epoch at time of action |
| `approvalId` | string | ApprovalBridge capability ID that authorized this action |
| `actorDigest` | string | SHA-256 of the normalized actor identity |
| `actionDigest` | string | SHA-256 of the normalized action + inputs |

### 5.2 Evidence Object Requirements

The `evidence` object must contain at minimum:

```json
{
  "directive": "<directive file path or version hash>",
  "task": "<task packet ID>",
  "inputs_digest": "<sha256 of normalized inputs>",
  "outputs_digest": "<sha256 of normalized outputs>",
  "approval": "<approvalId or null if not required>",
  "model_calls": [
    { "provider": "<PROVIDER>", "model": "<MODEL>", "tokens_in": 0, "tokens_out": 0 }
  ],
  "tool_calls": [
    { "tool": "<tool_name>", "status": "success|failure" }
  ]
}
```

Private content (prompt text, LLM completions, memory entries, message bodies)
must NOT appear in evidence. Only hashes, counts, and status labels.

### 5.3 Receipt Chain Verification

The receipt chain must be traversable from the most recent receipt back to the
bootstrap receipt for a given loop run. Verification:

1. Load receipt at head of chain.
2. Recompute `sha256` of the receipt content (excluding the `sha256` field
   itself). Confirm it matches `sha256`.
3. Load receipt at `previousReceiptId`. Confirm its computed hash matches
   `previousReceiptHash`.
4. Repeat until `previousReceiptId` is `null` (genesis receipt).

A chain with ANY broken link, missing receipt, or hash mismatch fails
verification. A receipt with `sha256:[REDACTED]` is invalid and must be
rejected.

### 5.4 Immutability Requirement

Once a receipt is written to the ReceiptJournal, it must not be modified.
Append-only writes. The index append must be atomic (write to temp file, then
rename). A partially-written receipt that fails atomicity must be rolled back
and the action treated as failed.

### 5.5 Causal Chain Requirement

The full causal chain for any consequential action must be reconstructable
from receipts alone:

```
directive version → task packet → evidence digest → model/tool calls
  → approval (if required) → action outputs → state transition
  → resulting artifact/commit
```

Missing any link in this chain fails the conformance check for receipts.

---

## 6. Task Leasing and Replay Protection

### 6.1 Task Lease Schema

See `schemas/task-lease.schema.json` for the machine-readable definition.

Every work packet in WorkRouter MUST carry:

| Field | Type | Description |
|-------|------|-------------|
| `packetId` | string | Unique task identifier |
| `title` | string | Human-readable task description |
| `type` | string | Task classification |
| `status` | string | Enumerated status (see 6.2) |
| `owner` | string \| null | Currently leasing agent/loop ID |
| `attemptId` | string | Unique identifier for the current execution attempt |
| `fencingEpoch` | integer | Monotonically increasing epoch; incremented on every supervisor restart |
| `leaseExpiry` | string | ISO 8601 timestamp; the lease is invalid after this time |
| `sideEffectKey` | string | Idempotency key for the task's side effects |

### 6.2 Task Status Enumeration

| Status | Description |
|--------|-------------|
| `pending` | Task exists, no owner |
| `leased` | Task is claimed by `owner` with an active lease |
| `awaiting_approval` | Task is paused waiting for human approval |
| `blocked` | Task cannot proceed, documented in task metadata |
| `completed` | Task is done, evidence written, receipt linked |
| `failed` | Task failed after retries and escalation |
| `dead` | Task is permanently abandoned (e.g., superseded, invalid) |

### 6.3 Lease Acquisition Protocol

```
1. Agent reads task at packetId.
2. If task.status is not "pending": reject — task already owned.
3. Compare-and-set: set owner=<agentId>, status="leased",
   attemptId=<new UUID>, leaseExpiry=<now + TTL>,
   fencingEpoch=<current supervisor epoch>.
   This write must be atomic (compare-and-set with optimistic lock version).
4. If CAS fails (another agent won the race): agent backs off.
5. Agent confirms its lease is still valid before each step
   (leaseExpiry > now AND fencingEpoch matches supervisor's current epoch).
```

### 6.4 Lease Renewal

An agent must renew its lease before `leaseExpiry` to continue holding it.
Renewal extends `leaseExpiry` and emits a lease-renewal receipt. If renewal
fails (store unavailable), the agent must treat its current step as the last
safe step and write a checkpoint receipt before stopping.

### 6.5 Stale Lease Recovery

The supervisor checks for expired leases on every cycle:

```
for each task with status="leased":
  if task.leaseExpiry < now:
    increment task.fencingEpoch
    set task.status = "pending", task.owner = null
    emit a stale-lease-recovery receipt
```

Any agent that attempts to complete a step after its lease has expired and
the epoch has been incremented must detect the epoch mismatch and abort
(do not write a completion receipt with a stale epoch).

### 6.6 Replay Protection

The `sideEffectKey` is a stable idempotency key for the task's irreversible
side effects (e.g., `SHA-256(task_type + normalized_inputs)`). Before
executing any irreversible step, an agent MUST check whether a completion
receipt for this `sideEffectKey` already exists. If it does, the action is
a duplicate and must be skipped (return the existing receipt instead).

This prevents double-posting, double-deployment, or double-spend from a
crash-restart scenario.

### 6.7 Dual-Owner Prevention

Two loops or agents MUST NOT hold a valid lease on the same task
simultaneously. The compare-and-set protocol in 6.3 enforces this at the
store level. The integration test for this invariant is:

```
1. Agent A acquires lease on task T (CAS succeeds).
2. Concurrently, Agent B attempts to acquire lease on task T.
3. EXPECTED: Agent B's CAS fails; B backs off; task.owner remains A.
4. PASS if and only if B never executes the task's side effects.
```

---

## 7. Memory and Succession Protocol

### 7.1 Three-Tier Memory Architecture

| Tier | Store | Durability | Scope |
|------|-------|------------|-------|
| Working | In-context (conversation history) | Ephemeral — wiped on compaction | Current turn |
| Episodic | Knowledge graph (Bonfire) | Durable — survives restarts | Cross-loop, cross-session |
| Portable checkpoint | Directive `## STATE` block + local file | Durable — survives Bonfire outage | Single loop |

**Critical requirement:** recovery state must be available without Bonfire.
The `## STATE` block and local checkpoint file constitute the portable
checkpoint. A loop must be resumable from these alone if Bonfire is unavailable.

### 7.2 Compact Protocol (Mandatory)

Verbatim from the ZOL directive — these rules apply to all loops in the fleet:

> **COMPACT PROTOCOL — context is disposable, knowledge is NOT.**
> Your conversation WILL be compacted/cleared — anything not persisted is lost.
>
> 1. On COMPLETING each work item: push ONE knowledge-graph episode:
>    `name=loop:<session>:<item-slug>`, body = 2-4 sentences: what you did,
>    the key decision/lesson, the PR/doc link. Best-effort — never block on it.
> 2. BEFORE any /clear or when context feels heavy: write a session-summary
>    episode (what is mid-flight, what the next session must know) + append a
>    3-line `## STATE` block to your directive file (overwrite the prior STATE).
> 3. LESSONS go to the directive file (`## LESSONS`, append) — operating
>    knowledge lives in files, not chat history.
>
> This makes any future session resume from graph + directive + board with zero loss.

### 7.3 Succession Protocol

The succession protocol defines how a loop hands off to a newly-started
instance of itself after a context wipe, crash, or supervisor restart.

**Step 1 — Quiesce:** Before context is wiped or process exits, the loop
must finish or checkpoint its current item. If mid-step, write a partial
completion receipt with `status: "pending"` and the current step index.

**Step 2 — Persist:** Write the session-summary Bonfire episode + update
the `## STATE` block in the directive file. This is the portable handoff packet.

**Step 3 — Adopt:** On startup, the successor reads the directive `## STATE`
block. If a partial completion receipt exists for a task, the successor must
either:
  - Resume the task from the checkpointed step (using the existing
    `attemptId` and `leaseExpiry`), OR
  - Acquire a new lease (new `attemptId`, incremented `fencingEpoch`) and
    restart the task from the beginning (safe if `sideEffectKey` replay
    protection is in place).

**Step 4 — Verify:** The successor must verify that no duplicate side effects
were committed during the handoff window (check `sideEffectKey` in the
receipt journal before proceeding).

### 7.4 Bonfire Outage Recovery

If the Bonfire knowledge graph is unavailable:

1. The loop continues using the portable checkpoint (directive `## STATE`).
2. The loop writes Bonfire episodes to a local fallback queue file
   (`~/.zao/bonfire-queue.jsonl`).
3. On Bonfire restoration, the queue is drained in order.
4. Recovery from Bonfire outage using only the portable checkpoint MUST be
   testable and must be tested in the conformance suite.

### 7.5 Memory Privacy Boundaries

| Memory Type | Exportable in Proof Drop | Exportable in Receipt Evidence |
|-------------|--------------------------|--------------------------------|
| Working memory (in-context) | No — never | No — digest only |
| Episodic (Bonfire) | No — internal | No — episode ID only |
| Relationship records | No — private | No — contact ID only |
| Artifact content | Sanitized only | SHA-256 hash only |
| Source citations | Yes | Yes |
| Task metadata | Yes (redacted fields) | Yes |
| Approval decisions | Yes (no tokens/keys) | Yes |

---

## 8. Approval and Escalation Policy

### 8.1 Human Authority Boundary

Telegram (via `<TELEGRAM_BOT_NAME>`) is ZOL's sole human gate for
public actions. No competing approval system may be introduced. The
ApprovalBridge is the adapter through which all approval requests flow;
it does not replace the Telegram gate.

### 8.2 Fail-Closed Requirement

ApprovalBridge MUST fail closed. On any ApprovalBridge error, timeout,
ambiguity, or unavailability, the associated action is DENIED, not allowed.
This is unconditional.

### 8.3 Approval Request Fields

Every approval request bound through ApprovalBridge must carry:

| Field | Required | Description |
|-------|----------|-------------|
| `requestId` | Yes | Unique approval request identifier |
| `action` | Yes | The action string from the authority matrix |
| `inputDigest` | Yes | SHA-256 of normalized inputs |
| `actor` | Yes | The requesting agent/loop ID |
| `expiry` | Yes | ISO 8601 timestamp; request is void after this |
| `scope` | Yes | Capsule ID + permission tier |

### 8.4 Approval Capability

A granted approval produces a one-use capability token. This token:

- Is bound to the specific `requestId`, `action`, `inputDigest`, `actor`, and `scope`
- Is single-use (consumed atomically on first valid use)
- Cannot be replayed after use or expiry
- Cannot be transferred to a different actor
- Must be consumed via `ApprovalBridge.consume()` before ToolGateway executes
  the action

### 8.5 Approval Validation (ToolGateway)

Before executing any `live_guarded_action` or `production_write` action,
ToolGateway MUST verify:

1. The approval capability exists and is unconsumed
2. `capability.requestId` matches the inbound request
3. `capability.action` matches the requested action
4. `capability.inputDigest` matches SHA-256 of the normalized inputs
5. `capability.actor` matches the requesting agent
6. `capability.expiry` is in the future
7. `capability.scope` matches the capsule/tier of the request

If ANY check fails, the action is denied and a denial receipt is written.

### 8.6 Escalation Ladder

When a loop cannot proceed without human input:

1. **Level 1 — Status channel ping:** Post `"DECISION NEEDED: <item>"` to
   `<STATUS_CHANNEL>`. Wait up to `<DECISION_TIMEOUT>` (e.g., 24h).
2. **Level 2 — Approval request:** Submit formal `ApprovalBridge.request()`
   with full context. Telegram gate notifies the human.
3. **Level 3 — Blocked state:** If no decision after timeout, transition loop
   to `blocked` state, write a blocked-state receipt, and surface the blocker
   on the fleet board.
4. **Level 4 — Dead-end:** If the task cannot proceed indefinitely, transition
   to `failed`, write a failure receipt, and mark the task on the board for
   human review.

### 8.7 Auto-Answer Prohibition

The supervisor and ApprovalBridge MUST NOT auto-answer generic approval
dialogs. The specific pattern `"1. Yes"` appearing in terminal output must
only trigger a response when the context is a known, controlled permission
dialog (not arbitrary LLM output that happens to contain that string).

---

## 9. Deployment and Rollback Rules

### 9.1 Change Promotion Path

All code changes follow this exact promotion path. No step may be skipped:

```
draft PR (agent branch) → CI green → human review → merge to main
  → manual Pi deployment (operator command, not automated)
```

### 9.2 Pi Deployment Gate

Deployment to the Pi production host requires:

1. A merged PR on `main` (the change is already reviewed)
2. Operator (Zaal) runs the deployment command manually on the Pi:
   ```bash
   cd /home/<USER>/<REPO> && git pull && npm ci --omit=dev
   ```
3. The operator restarts the relevant daemons after verifying the deploy:
   ```bash
   sudo systemctl restart <SERVICE_NAME>
   ```
4. A deployment receipt is written (manual or via the deployment script)
   confirming the git SHA and daemon restart time.

No agent may initiate an SSH connection to the Pi, run `git pull` on the
production host, or restart a systemd service. `deployment.production.write`
is permanently blocked for all agents.

### 9.3 Rollback Procedure

**Pre-merge rollback:** Close the PR. No git action required.

**Post-merge, pre-deploy rollback:** Open a revert PR targeting `main`.
Human reviews and merges. Operator deploys the revert.

**Post-deploy rollback:**
1. On the Pi: `git revert <BAD_COMMIT_SHA>` (creates a new commit, no
   force-push).
2. Or: `git checkout <LAST_GOOD_SHA> -- <affected files>`, commit, push PR.
3. Operator restarts affected daemons after confirming the rollback.

**Data state rollback:** Changes to SQLite state or MemoryWeaver that must
be undone require manual operator action. The atomic backup produced before
each migration is the restore target:
```bash
sqlite3 <STATE_DB> "VACUUM INTO '/tmp/<STATE_DB>.backup.<TIMESTAMP>'"
# ... then restore if needed
cp /tmp/<STATE_DB>.backup.<TIMESTAMP> <STATE_DB>
```

### 9.4 Artifact Lifecycle Transitions

Artifacts follow this strict promotion path:

```
planned → built → verified → packaged → delivered
```

- Skipping stages is rejected (e.g., `planned → packaged` is invalid).
- A substantive edit to a `verified` artifact returns it to `built`.
- A substantive edit to a `packaged` artifact returns it to `built`.
- Approval is only granted for artifacts at `verified` or higher.
- `delivered` is terminal — further edits require a new artifact version.

---

## 10. Failure-Mode Tests

The following failure scenarios MUST be covered in the integration test suite.
Each test must produce a verifiable receipt demonstrating the correct failure
handling behavior.

### 10.1 Required Failure-Mode Tests

| Test ID | Scenario | Expected Outcome |
|---------|----------|------------------|
| FM-01 | Duplicate task execution (same packetId, two agents) | Second CAS fails; only one agent executes; no duplicate side effects |
| FM-02 | Stale lease (leaseExpiry exceeded before step completes) | Supervisor increments epoch; agent detects mismatch; step aborted cleanly |
| FM-03 | Supervisor restart (new epoch issued) | Old-epoch agents detect mismatch; new supervisor acquires lock; fleet resumes |
| FM-04 | Approval timeout (no human response within expiry) | Action denied; denial receipt written; loop transitions to `failed` |
| FM-05 | Memory (Bonfire) outage | Loop resumes from portable checkpoint; no state loss; queue drained on restore |
| FM-06 | Receipt write failure | Consequential action aborted (fail closed); error receipt attempted; loop transitions to `failed` |
| FM-07 | Partial completion on crash (mid-step) | On restart, successor detects partial receipt; replays from checkpoint or acquires new lease |
| FM-08 | Replay of completed action (duplicate sideEffectKey) | Duplicate detected; existing receipt returned; no re-execution of side effects |
| FM-09 | Approval replay (reuse of consumed capability) | Second `consume()` call rejected; action denied; replay receipt written |
| FM-10 | Unauthenticated AgentGateway access | Request rejected with 401; no capability granted |
| FM-11 | Model substitution that raises authority/risk | Fallback blocked or re-approval required; substitution logged |
| FM-12 | Two supervisors on same host | Second supervisor fails to acquire flock; exits cleanly |
| FM-13 | Secret exposed in receipt evidence | Receipt write rejected by secret scanner; audit alert emitted |
| FM-14 | PR push attempt to main by agent | Push rejected by Git hook; attempt logged as violation |

### 10.2 State-Machine Recovery Suite (Required)

These seven scenarios MUST be covered in the integration suite and must all
pass before any PR that touches the WorkRouter, ReceiptJournal, ApprovalBridge,
MemoryWeaver, or AgentGateway is considered ready for merge:

1. Duplicate execution (same task, two workers) — see FM-01
2. Partial completion (crash mid-step) — see FM-07
3. Stale lease (TTL exceeded) — see FM-02
4. Supervisor restart (epoch increment) — see FM-03
5. Approval timeout — see FM-04
6. Memory outage (Bonfire unavailable) — see FM-05
7. Receipt-write failure — see FM-06

---

## 11. Redaction and Secret-Handling Rules

### 11.1 What Counts as a Secret

The following field types are secrets and must NEVER appear in Git, logs,
fixtures, receipts, Proof Drop bundles, or terminal output:

- Private keys (Ed25519, ECDSA, RSA) in any encoding
- API tokens, bearer tokens, JWT secrets
- Telegram bot tokens and chat IDs
- Database connection strings with embedded credentials
- Wallet private keys or mnemonics
- OAuth client secrets
- Webhook URLs that contain embedded auth tokens

The following are NOT secrets and must NOT be redacted:

- SHA-256 content hashes (`sha256:<64-hex>`)
- Commit SHAs
- Receipt IDs (UUIDs or `rcpt-<hash>`)
- Idempotency keys
- Environment variable NAMES (not their values)
- Public Farcaster IDs (FIDs)
- Public agent identifiers

### 11.2 Secret Detection Rules

Secret detection MUST check field CONTEXT, not value format alone:

| Pattern | Classification | Rule |
|---------|---------------|------|
| Field name contains `privateKey`, `secretKey`, `mnemonic`, `seed`, `password`, `bearer`, `token` AND value is non-empty | SECRET | Block from output |
| Field name contains `hash`, `digest`, `sha`, `checksum` AND value matches `sha256:[0-9a-f]{64}` | NOT A SECRET | Allow through |
| Field name contains `id`, `_id`, `Id` AND value is UUID format | NOT A SECRET | Allow through |
| Value matches a known API token format (e.g., `sk-...`, `xoxb-...`) regardless of field name | SECRET | Block from output |
| 64-char hex string in a field named `commitSha`, `contentHash`, `receiptHash` | NOT A SECRET | Allow through |

### 11.3 Secret Scan Requirements

`scripts/secret-scan.sh` MUST exist and MUST:

1. Run without requiring bash extensions (compatible with `sh`)
2. Scan all tracked files for known secret patterns
3. Exit non-zero if any secret pattern is found
4. Be runnable in CI without a local shell environment
5. Exclude known-safe patterns (content hashes, UUIDs, env var names)

### 11.4 Proof Drop Redaction Rules

A Proof Drop bundle (sanitized export for sharing) MUST:

- Recursively remove all fields named: `prompt`, `memory`, `secret`,
  `privateKey`, `token`, `credential`, `password`, `mnemonic`, `bearer`
- Preserve all content hashes, receipt IDs, approval IDs, and task metadata
- Recompute content hash after redaction (hash of the redacted content,
  not the original)
- Reject `sha256:[REDACTED]` as invalid — a redacted hash means the hash
  cannot be verified, which invalidates the proof
- Include the redaction manifest: a list of fields that were removed and
  why, without revealing the removed values

### 11.5 Environment Variable Policy

- Env var NAMES may appear in code, configs, and docs
- Env var VALUES must never appear in any tracked file
- Sensitive env vars are stored only in `~/.zao/private/` or
  `/etc/<SERVICE>.env` on the Pi, never in the repo
- The conformance harness must confirm no `.env` file with values is tracked

---

## 12. Versioning and Compatibility Policy

### 12.1 Fleet Standard Versioning

The Fleet Standard uses semantic versioning (`MAJOR.MINOR`):

- `MAJOR` bump: a change that breaks conformance of existing fleets
  (e.g., a new required section, a renamed required field, a removed state)
- `MINOR` bump: a backwards-compatible addition (new optional field,
  new recommended practice, new conformance test for an optional feature)

Current version: `v0.1` (DRAFT — not yet stable)

### 12.2 Schema Versioning

JSON schemas are versioned independently. Each schema file includes a
`$schema` field (JSON Schema draft-07) and a `version` metadata field.
Schema breaking changes require a new filename (e.g.,
`receipt.schema.v2.json`) with a migration guide.

### 12.3 Migration Rules

When a fleet upgrades from Fleet Standard `vX.Y` to `vX'.Y'`:

1. If `X' > X` (MAJOR bump):
   - Run the migration script: `scripts/fleet-migration-vX-to-vX'.sh`
   - All existing capsules and loops must be re-validated against the new schemas
   - All existing receipts must be verified against the new receipt schema
   - Re-run the full conformance harness before treating the fleet as certified

2. If `X' == X` (MINOR bump):
   - New optional fields default to `null` or omitted in existing records
   - No migration script required
   - Re-run conformance harness to confirm no regression

### 12.4 Capsule and DreamLoop Schema Compatibility

- The `schema` field in each capsule/loop manifest pins the schema version
  (`dreamnet.synergy_capsule.v1`, `dreamnet.dreamloop.v1`)
- A capsule or loop with an unknown `schema` value must be rejected at
  validation time, not silently ignored
- Schema version pinning prevents silent behavior changes when the runtime
  is upgraded

### 12.5 DreamLoops Vendor Pin

The DreamLoops runtime is pinned at a specific git commit in
`vendor/dreamloops/`. The pinned commit SHA is the canonical contract for
capsule/loop validation. Upgrading the vendor pin requires:

1. A PR with the new pin
2. Re-validation of all capsules and loops against the new validator
3. A note in the PR describing any behavioral differences

---

## 13. Conformance Checklist and Executable Harness

### 13.1 Conformance Checklist

A fleet instance is considered conformant when ALL of the following are true:

**Invariants**
- [ ] INV-1: No direct push to main by any agent (confirmed by Git hook or CI check)
- [ ] INV-4: Secret scan passes with zero findings
- [ ] INV-7: No public post path exists without passing through ApprovalBridge
- [ ] INV-9: All consequential actions produce receipts
- [ ] INV-12: Telemetry contains no raw content
- [ ] INV-14: Supervisor same-host lock is implemented and tested (FM-12)
- [ ] INV-15: Fencing epoch increments on supervisor restart (FM-03)

**Schemas**
- [ ] All capsules in `capsules/` validate against `schemas/capsule.schema.json`
- [ ] All loops in `loops/` validate against the DreamLoop schema (schema field + required fields)
- [ ] At least one receipt validates against `schemas/receipt.schema.json`
- [ ] At least one task lease validates against `schemas/task-lease.schema.json`

**Loop Lifecycle**
- [ ] Every loop declares entry conditions, exit conditions, retry limits, escalation rules, and an owner
- [ ] State transitions follow the diagram in Section 4.2
- [ ] No loop is in `unknown` state when the supervisor prods (supervisor waits one cycle)

**Task Leasing**
- [ ] Dual-owner prevention test passes (FM-01)
- [ ] Stale lease recovery test passes (FM-02)
- [ ] Replay protection test passes (FM-08)

**Receipts**
- [ ] Receipt chain verification passes for all completed task runs
- [ ] No receipt contains `sha256:[REDACTED]`
- [ ] Causal chain is complete: directive → task → evidence → approval → action → outcome

**Approval**
- [ ] ApprovalBridge fails closed (tested with simulated error)
- [ ] Approval replay rejection test passes (FM-09)
- [ ] Telegram gate is the sole human approval path for public actions

**Memory**
- [ ] Bonfire outage recovery test passes (FM-05) using portable checkpoint only
- [ ] No memory content appears in Proof Drop bundles

**Deployment**
- [ ] `deployment.production.write` is blocked in every capsule's `blocked` list
- [ ] No agent code path triggers SSH, `git pull`, or `systemctl restart` on the Pi

**Code**
- [ ] `src/zol-lib.js` does NOT have `require('@farcaster/hub-nodejs')` at the top level
  (this module is Pi-only; importing it at module load breaks non-Pi environments)
- [ ] `scripts/secret-scan.sh` exists and exits 0 on the current codebase
- [ ] `src/approval-bridge.js` exports `ApprovalBridge` class and `consume` function

### 13.2 Executable Harness

The conformance harness is a single runnable script:

```bash
node scripts/fleet-conformance.js
```

It performs all automated checks and exits 0 on pass, non-zero on fail.
It prints a summary line:

```
N conformance checks passed, 0 failed
```

On failure it prints the specific failing checks before the summary.

See `scripts/fleet-conformance.js` for the implementation.

### 13.3 Running the Full Verification Gate

Before a fleet instance is considered production-candidate, ALL of the
following must be green:

```bash
npm ci
npm test
npm run dl:test
npm run v2:test
npm run v2:check
npm run dl:validate
npm run dl:secret-scan
node scripts/fleet-conformance.js
```

CI must run on every PR. No PR may bypass CI.

### 13.4 Threat Model (Summary)

| Threat | Mitigation | Test |
|--------|-----------|------|
| Agent pushes to main | Git hook + PR-only rule in directive | INV-1, FM-14 |
| Agent posts without approval | ApprovalBridge fail-closed + blocked action | INV-7, FM-04 |
| Two agents own same task | CAS lease protocol | FM-01 |
| Stale agent holds expired lease | Epoch fencing | FM-02 |
| Split-brain supervisor | Same-host flock | FM-12 |
| Receipt tampering | SHA-256 chain | INV-10, INV-11 |
| Secret in receipt | Secret scanner + field-context detection | INV-4, FM-13 |
| Approval replay | One-use capability + consume() | FM-09 |
| Memory loss on crash | Portable checkpoint + Bonfire queue | FM-05, FM-07 |
| Model substitution raises authority | Gateway fallback block | FM-11 |
| Private content in telemetry | Categorical-only telemetry | INV-12 |
| Terminal pane content leaks | Supervisor never forwards raw pane | INV-16 |

---

## 14. Supervisor Design Reference

> This section retains the original supervisor design from Fleet Standard v0.1.
> It is now grounded in the invariants and protocols above.

### 14.1 Overview

The supervisor is one shell script on a `* * * * *`-ish cron. It is
deliberately dumb: it reads each pane's last lines and pattern-matches to
decide one action. It must acquire the same-host lock (INV-14) before
taking any action.

### 14.2 The Script (redacted)

```bash
#!/bin/bash
# loops-keepalive.sh — fleet supervisor: approve/relaunch/prod + publish status.
# Acquires a same-host lock before touching any loop.

LOCKFILE="/tmp/fleet-supervisor.lock"
exec 200>"$LOCKFILE"
flock -n 200 || { echo "supervisor already running; exiting"; exit 0; }

# Fencing epoch — read from persistent store; increment on acquire.
EPOCH_FILE="/tmp/fleet-epoch"
EPOCH=$(cat "$EPOCH_FILE" 2>/dev/null || echo 0)
EPOCH=$((EPOCH + 1))
echo "$EPOCH" > "$EPOCH_FILE"

# session:workdir:directive triples
SESSIONS="loopA:/home/<USER>/<REPO_A>:loopA-directive.md \
          loopB:/home/<USER>/<REPO_B>:loopB-directive.md \
          loopC:/home/<USER>/<REPO_C>:loopC-directive.md"

for spec in $SESSIONS; do
  S="${spec%%:*}"; rest="${spec#*:}"; DIR="${rest%%:*}"; DRV="${rest##*:}"

  # (a) RELAUNCH: create the session if it does not exist
  tmux has-session -t "$S" 2>/dev/null || {
    tmux new-session -d -s "$S" -c "$DIR" "bash -l"; sleep 1
  }

  P=$(tmux capture-pane -t "$S" -p 2>/dev/null | tail -25)

  # (b) ACCEPT: the "trust this folder" screen blocks everything
  if echo "$P" | grep -qE "Yes, I accept|Yes, I trust this folder"; then
    tmux send-keys -t "$S" "2"; sleep 1; tmux send-keys -t "$S" Enter; continue
  fi

  # (c) APPROVE: a known, bounded permission dialog (not generic output)
  if echo "$P" | grep -qiE "Do you want to proceed\?.*\[1\. Yes"; then
    tmux send-keys -t "$S" "1"; sleep 1; tmux send-keys -t "$S" Enter; continue
  fi

  # (d) DISMISS: the feedback modal
  if echo "$P" | grep -q "How is Claude doing"; then
    tmux send-keys -t "$S" Escape; fi

  # (e) RELAUNCH into Claude: pane is at a bare shell prompt
  if echo "$P" | tail -3 | grep -qE '^\S*\$ ?$|<USER>@'; then
    tmux send-keys -t "$S" \
      "cd $DIR && /home/<USER>/bin/claude --dangerously-skip-permissions"
    sleep 1; tmux send-keys -t "$S" Enter; continue
  fi

  # (f) PROD: alive but not working -> re-issue the directive
  if ! echo "$P" | grep -q "esc to interrupt"; then
    tmux send-keys -t "$S" \
      "Read ~/$DRV and continue working it top to bottom. PR-only, self-sustaining."
    sleep 1; tmux send-keys -t "$S" Enter
  fi

  # (g) If running: do nothing (never interrupt a live turn)
done

# (h) PUBLISH: snapshot state to JSON + Supabase (categorical only — no raw pane content)
# ... (see Section 17)
```

### 14.3 Behavior Reference

| Step | Trigger | Action |
|------|---------|--------|
| (a) | tmux session missing | Create session at login shell |
| (b) | Trust-folder screen | Select trust option; Enter |
| (c) | Known permission dialog (bounded pattern) | Select Yes; Enter |
| (d) | Feedback modal | Escape to dismiss |
| (e) | Bare shell prompt in pane | cd to workdir; launch Claude |
| (f) | No "esc to interrupt" (not running) | Re-send directive prod |
| (g) | "esc to interrupt" present | Do nothing |
| (h) | After all sessions | Publish fleet status (categorical) |

### 14.4 Known Failure Modes

1. **Context fill (~939k tokens).** Long-lived loop degrades before hard
   failure. Supervisor cannot detect this. Mitigation: compact protocol.
   **Gap — detection is manual.**
2. **Typed-but-unsubmitted input.** `send-keys` then separate `Enter` required.
   `sleep 1` between calls reduces but does not eliminate the race.
3. **Parked vs stuck.** "Idle" means either correctly parked or hung. Both
   are re-prodded. A genuinely-parked loop may receive spurious prods.
   **Gap — no reliable signal to distinguish.**
4. **PATH on fresh shells.** Supervisor uses absolute path for `claude` binary.
   Loops call helpers by absolute path too.
5. **Trust-folder screen.** Handled by step (b); was a perpetual hang before.

---

## 15. Compact Protocol Reference

> Verbatim protocol text that must appear in every loop's directive:

```
COMPACT PROTOCOL — context is disposable, knowledge is NOT.
Your conversation WILL be compacted/cleared — anything not persisted is lost.
1. On COMPLETING each work item: push ONE knowledge-graph episode:
   name=loop:<session>:<item-slug>, body = 2-4 sentences: what you did, the
   key decision/lesson, the PR/doc link. Best-effort — never block on it.
2. BEFORE any /clear or when context feels heavy: write a session-summary
   episode (what is mid-flight, what the next session must know) + append a
   3-line ## STATE block to your directive file (overwrite the prior STATE).
3. LESSONS go to the directive file (## LESSONS, append) — operating
   knowledge lives in files, not chat history.
This makes any future session resume from graph + directive + board with zero loss.
```

**Why context is treated as ephemeral:**
A loop's memory is its context window, which is periodically summarized or
cleared. Treat context as a scratchpad that will be wiped, and write anything
that must outlive the turn to durable stores: the knowledge graph (searchable
across all loops and future sessions), the directive `## STATE` (the fast
resume-here pointer), and the board (the work queue).

**Self-test:** *If this session were cleared right now, could a fresh session
pick up with no loss from graph + directive + board alone? If not, something
important is still only in chat and must be persisted.*

---

## 16. Directive Template Reference

See Section 3.4 for the full template. Quick anatomy:

| Section | Purpose | Lifecycle |
|---------|---------|-----------|
| Identity + rules | Who this loop is; non-negotiables | Static |
| North Star | 1-2 goals every choice is weighed against | Static |
| Compact Protocol | Knowledge persistence rules | Static |
| Queue | Ordered backlog | Operator-managed |
| STATE | 3-line resume pointer | Overwritten on each compaction |
| LESSONS | Durable operating lessons | Appended |
| Self-improvement | Directive self-improvement cadence | Static |

---

## 17. Fleet Status Reference

### 17.1 `/tmp/fleet-status.json` Format (categorical only)

```json
{
  "updated": "2026-07-16T23:36:04Z",
  "supervisorEpoch": 7,
  "loops": [
    {
      "session": "loopA",
      "state": "idle",
      "last": "<USER>@<VPS>:~/<REPO_A>$",
      "updatedAt": "2026-07-16T23:36:04Z"
    },
    {
      "session": "loopB",
      "state": "running",
      "last": "  bypass permissions on . esc to interrupt",
      "updatedAt": "2026-07-16T23:36:04Z"
    },
    {
      "session": "loopC",
      "state": "dead",
      "last": null,
      "updatedAt": "2026-07-16T23:36:04Z"
    }
  ]
}
```

`state` is one of: `idle`, `triggered`, `running`, `awaiting_approval`,
`blocked`, `completed`, `failed`, `dead`, `unknown`.

`last` is the last non-blank pane line, truncated to 110 characters. It must
never contain a full terminal pane dump, API tokens, or raw LLM output.

### 17.2 Supabase `fleet_status` Table

| Column | Type | Notes |
|--------|------|-------|
| `session` | text (PK) | Loop name |
| `state` | text | One of the enumerated states |
| `supervisor_epoch` | integer | Current fencing epoch |
| `last_line` | text | Truncated (≤110 chars), no raw content |
| `updated_at` | timestamptz | Supervisor run timestamp |

### 17.3 Edge-Triggered Alerting

The supervisor keeps `/tmp/fleet-prev.json` and diffs states on each run.
Only on a state CHANGE does it emit to the status channel:

```
FLEET: loopB: running -> dead, loopC: idle -> running
```

This is the single cheapest, highest-signal monitoring piece. A healthy
fleet is silent; only transitions page a human.

---

## 18. Handoff Example

This is an EXAMPLE — not live data. Illustrates the three artifacts a loop
produces to enable zero-loss handoff.

### (a) Item-Completion Episode (pushed on finishing a work item)

```json
{
  "name": "loop:2026-07-16:fix-deadline-parser",
  "body": "Fixed a false-positive in the bounty deadline parser: it keyed only on the word 'deadline' then grabbed any date as a fallback, so an event kickoff date got read as the submission deadline. Now a date only counts when it sits right after a deadline keyword (deadline/closes/due/ends/submit by). Added a network-free selftest, 7/7. PR: <REPO>#30."
}
```

### (b) Pre-Clear Session-Summary Episode (pushed before compaction)

```json
{
  "name": "loop:2026-07-16:session-summary",
  "body": "Shipped 12 PRs this session, mostly hardening the submission pipeline (two deadline parsers + leaderboard pagination) plus two design specs. MID-FLIGHT: nothing half-done; all PRs verified + pushed, all clones cleaned. NEXT SESSION MUST KNOW: one urgent runtime PR (#<N>) fixes a syntax error that crashes a bot on restart — flag the human to merge it first. A second writer was observed committing in the shared clone — watch for it."
}
```

### (c) Directive `## STATE` Block (overwrites prior STATE)

```markdown
## STATE (2026-07-16 23:40)
Mid-flight: none — queue worked to genuine blockage; all work PR'd + verified.
Next: merge urgent boot-fix PR #<N> before the bot restarts; then runtime PRs.
Watch: a concurrent writer is driving the shared clone (isolate via worktrees).
```

Together these three let a fresh session reconstruct state with no chat
history: the graph gives the "why + links", the STATE block gives the
"resume here", the board gives the "what's next".

---

*Fleet Standard v0.1 — DRAFT — ZOL v2 operating system — bettercallzaal/zol*
*Last updated: 2026-07-16*
*License: MIT (draft — pending repository owner approval)*
