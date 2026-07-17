# ZOL Keystone 3: ZOE → ZOL Intent Bridge Design v1

**Date:** 2026-07-17
**Status:** DESIGN ONLY — no implementation until v2 PRs (#26-#39) merge to main
**Author:** ZOL loop directive (Brandon-authored spec, Zaal-approved 2026-07-16)
**Implements:** Keystone 3 from the ZOL v2 directive (board task 85d6860b)

> "After ZOL v2 PRs are merged, wire ZOE concierge dispatch to route music/curation/agent intents
> to ZOL DreamLoops via agent-gateway (localhost:8089). ZOE currently has topic-router.ts but no
> ZOL-aware intent bridge. Implement in zao-os/bot/src/zoe/intent-router.ts." — board task 85d6860b

---

## Problem

ZOE (the VPS concierge, `zao-os/bot`) can receive Zaal intents via Telegram topics, DMs, and
inline commands, but has no mechanism to delegate music/curation/agent tasks to ZOL's DreamLoop
runner on the Pi.

ZOL (`bettercallzaal/zol`) has a complete agent gateway at `localhost:8089` with 13 routes and
7 MCP tools, but it runs on the Pi (not the VPS) and is intentionally localhost-only by default.

The Keystone 3 bridge must:
1. Let ZOE recognize ZOL-appropriate intents (music scouting, artist context, weekly curation,
   source citation, work routing, proof-drop, memory queries)
2. Dispatch those intents to ZOL without exposing the Pi's agent-gateway publicly
3. Preserve the existing security invariants: no ungated public posting, Telegram remains the sole
   human authority gate, no wallet or signer access

---

## Current Architecture

```
Telegram → ZOE (VPS, zao-os/bot)
             └─ topic-router.ts  → {research, coding, capture, draft, chat}
             └─ index.ts         → execute action, reply in topic

Pi (ansuz) → ZOL (bettercallzaal/zol)
             └─ agent-gateway.js → localhost:8089
             └─ DreamLoop Runner → 72 loops
             └─ cron / tmux      → scheduled loop execution
```

ZOE and ZOL have no direct runtime link today. The only shared channel is the **ZAOcowork
Supabase board** (accessible to both via `COWORK_TRACKER_URL` / `COWORK_TRACKER_KEY`).

---

## Design Options

### Option A: Supabase Board as Message Bus (Recommended for v1)

ZOE translates an intent into a **board task** with a ZOL-native tag. ZOL's existing
`detect-work-intent` and `route-work` DreamLoops pick it up on the next polling cycle.

```
ZOE (intent received)
  → board.task.create({ type: "zol-intent", title: "...", metadata: { loop, inputs } })
  → reply to Zaal: "Routed to ZOL — will surface result on next cycle"

ZOL (detect-work-intent DreamLoop, every 15 min)
  → reads board tasks with type="zol-intent" and status="todo"
  → claims task (conditional PATCH ?status=eq.todo)
  → creates internal WorkRouter packet
  → runs target DreamLoop
  → writes result back to board task notes + posts receipt
  → board task → done
```

**Pros:**
- Zero new infrastructure: both systems already have Supabase access
- Asynchronous: Pi's polling cadence is fine for music/curation intents (not latency-sensitive)
- Full audit trail: every intent becomes a board task row with evidence
- Survives Pi restart: task remains on board until claimed

**Cons:**
- ~15 min latency (one poll cycle)
- ZOE cannot wait for ZOL's result in the same Telegram thread without a follow-up notification

**ZOE sends:**
```json
{
  "title": "ZOL: [intent summary]",
  "category": "engineering",
  "priority": "P2",
  "metadata": {
    "intent_type": "music-scout | artist-context | weekly-curator | source-citation | query-memory",
    "loop": "music-scout-v1 | artist-context-v1 | ...",
    "inputs": { "artist": "...", "fid": 123 },
    "zoe_thread_id": 456,
    "requested_by": "zaal"
  }
}
```

**ZOL reads** tasks where `metadata->>'intent_type' IS NOT NULL AND status = 'todo'`.

---

### Option B: SSH Tunnel + Direct MCP Call (v2, when real-time response needed)

ZOE opens a short-lived SSH tunnel to the Pi, calls the ZOL agent-gateway `run_loop` MCP tool,
and receives the result synchronously before replying to Zaal.

```
ZOE → ssh -L 18089:localhost:8089 pi@ansuz "sleep 30" &
ZOE → POST http://localhost:18089/mcp/execute { tool: "run_loop", args: { loop: "music-scout-v1", inputs: {...} } }
ZOE → kill tunnel, reply with result
```

**Pros:** Real-time response within the same Telegram thread

**Cons:**
- Requires SSH key from VPS → Pi (new credential, new attack surface)
- SSH connection adds ~500ms overhead
- Pi must have the VPS's SSH key in `~/.ssh/authorized_keys`
- Connection management complexity

**Recommendation:** Implement Option B only after Option A proves stable. The latency of Option A
is acceptable for ZOL's current use cases (all are best-effort, none are time-critical).

---

### Option C: ZOL Polls Telegram (No ZOE code changes)

ZOL adds a `tg-intent-poll` DreamLoop that reads Zaal's Telegram DMs for structured intent
commands and self-routes them.

**Rejected:** Requires parsing unstructured user input in ZOL, creating a second intent-parsing
system parallel to ZOE's. Fragile and duplicative.

---

## Recommended: Option A Implementation Plan

### Step 1: ZOE side — `zao-os/bot/src/zoe/intent-router.ts` (new file)

```typescript
// intent-router.ts — ZOL-aware intent dispatch from ZOE
// Branch on message content/topic to decide if this is a ZOL intent

export type ZolIntent =
  | { kind: 'music-scout';       farcasterHandle?: string }
  | { kind: 'artist-context';    farcasterHandle: string }
  | { kind: 'weekly-curator' }
  | { kind: 'source-citation';   url: string }
  | { kind: 'query-memory';      query: string };

/** Classify a user message as a ZOL intent or null (ZOE handles it). */
export function classifyZolIntent(
  messageText: string,
  topicName: string | undefined
): ZolIntent | null {
  // "scout" / "music scout" → ZOL music-scout loop
  if (/\b(scout|music.?scout)\b/i.test(messageText)) {
    return { kind: 'music-scout' };
  }
  // "@handle context" or "artist context @handle"
  const artistCtx = messageText.match(/\b(artist.?context|context)\b.*@(\w+)/i)
    || messageText.match(/@(\w+).*\b(context)\b/i);
  if (artistCtx) {
    return { kind: 'artist-context', farcasterHandle: artistCtx[1] };
  }
  // "cite <url>" or "source <url>"
  const citeUrl = messageText.match(/\b(cite|source)\b\s+(https?:\/\/\S+)/i);
  if (citeUrl) {
    return { kind: 'source-citation', url: citeUrl[2] };
  }
  // "recall / remember / query memory"
  const memMatch = messageText.match(/\b(recall|remember|memory|what do you know about)\b\s+(.+)/i);
  if (memMatch) {
    return { kind: 'query-memory', query: memMatch[2] };
  }
  return null;
}

/** Map a ZolIntent to the ZOL DreamLoop name and inputs. */
export function intentToLoop(intent: ZolIntent): { loop: string; inputs: Record<string, unknown> } {
  switch (intent.kind) {
    case 'music-scout':
      return { loop: 'music-scout-v1', inputs: { handle: intent.farcasterHandle } };
    case 'artist-context':
      return { loop: 'artist-context-v1', inputs: { handle: intent.farcasterHandle } };
    case 'weekly-curator':
      return { loop: 'weekly-curator-v1', inputs: {} };
    case 'source-citation':
      return { loop: 'source-citation-v1', inputs: { url: intent.url } };
    case 'query-memory':
      return { loop: 'source-citation-v1', inputs: { query: intent.query } }; // nearest available loop
    default:
      throw new Error(`Unknown ZOL intent kind`);
  }
}
```

### Step 2: ZOE side — board task dispatch

In `zao-os/bot/src/index.ts` (or the topic routing handler), after classifying an intent:

```typescript
import { classifyZolIntent, intentToLoop } from './zoe/intent-router';
import { CoworkTracker } from '../cowork-tracker'; // existing ZOE tracker client

const zolIntent = classifyZolIntent(messageText, topicName);
if (zolIntent) {
  const { loop, inputs } = intentToLoop(zolIntent);
  await tracker.createTask({
    title: `ZOL: ${zolIntent.kind} (from Zaal via ZOE)`,
    category: 'engineering',
    priority: 'P2',
    metadata: {
      intent_type: zolIntent.kind,
      loop,
      inputs,
      zoe_thread_id: message.message_thread_id,
      requested_by: 'zaal',
    },
  });
  await bot.sendMessage(chatId, `Queued for ZOL: ${zolIntent.kind}. Result on next cycle (~15 min).`, { ... });
}
```

### Step 3: ZOL side — `detect-work-intent` DreamLoop update

Add a handler that reads board tasks with `metadata.intent_type` set, claims them via the
existing conditional PATCH (`?status=eq.todo`), and dispatches to the appropriate DreamLoop:

```javascript
// src/handlers/index.js — add to existing handlers
'board.zol-intent.claim': async function({ input, state, signal }) {
  // Read unclaimed ZOL intents from the board
  const tasks = await coworkTracker.listTasks({ filter: 'metadata->>intent_type.not.is.null', status: 'todo' });
  for (const task of tasks) {
    const claimed = await coworkTracker.claimTask(task.id); // conditional PATCH
    if (!claimed) continue; // race — another instance claimed it
    const { loop, inputs } = task.metadata;
    // Dispatch to DreamLoop runner
    const runner = new DreamLoopRunner(state, { ...handlers });
    const result = await runner.run(loop, inputs, { signal });
    // Write result back to board
    await coworkTracker.updateTask(task.id, { status: 'done', notes: JSON.stringify(result) });
  }
  return { claimed: tasks.length };
},
```

---

## ZOL Agent-Gateway Endpoints (Ready — blocked on merge)

Once PRs #26-#39 merge to main, the following ZOL endpoints are available on `localhost:8089`:

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Agent health + capsule/loop counts |
| GET | `/agent-card` | ZOL agent identity card |
| GET | `/capabilities` | Available capabilities list |
| POST | `/tasks` | Create a work packet |
| GET | `/tasks/:id` | Retrieve a work packet |
| GET | `/dreamloops` | List all 72 registered loops |
| POST | `/mcp/execute` | Execute an MCP tool directly |

**Relevant MCP tools for ZOE intents:**

| Tool | Use case |
|------|----------|
| `run_loop` | Run any DreamLoop by name with inputs |
| `create_work_packet` | Create a work packet from intent |
| `query_memory` | Query ZOL's sourced memory |
| `request_approval` | Submit an approval request to Telegram |

---

## Security Invariants (Unchanged)

The intent bridge must not bypass any existing invariant:

1. **No ungated public posting.** ZOL's ApprovalBridge requires Telegram approval for any cast.
   The ZOE→ZOL bridge dispatches loops; loops still gate outbound actions via `bridge.consume()`.
2. **No wallet or signer access.** No intent type triggers a financial or signing action.
3. **Telegram remains the sole authority.** ZOE's role is classification and dispatch only.
   ZOL's role is execution within its existing approval gates.
4. **Board task as idempotency key.** The board task ID is used as the `idempotencyKey` for the
   ZOL work packet, preventing duplicate executions if ZOE sends the same intent twice.
5. **Secrets stay in `.env`.** No intent payloads contain secrets. Board task `metadata` is
   inputs only (handles, URLs, queries) — never tokens or keys.

---

## Open Questions for Zaal/Brandon

1. **Response latency**: Is ~15 min acceptable, or do certain intents (artist context lookups
   during a live music session) need real-time response? If so, Option B (SSH tunnel) is needed.
2. **Topic mapping**: Should the ZOL topic in ZAAL BOTZ (`topic-router.ts` case `'ZOL'`) be
   expanded to include these intent classifiers, or should a separate ZOL-specific topic forum
   be created?
3. **Result notification**: When ZOL completes a dispatched loop, should it notify Zaal via
   Telegram? If so, through which bot (ZOE or ZOL directly)?
4. **Pi accessibility**: Is the VPS able to SSH to the Pi (for Option B readiness)? If so,
   document the key setup in the fleet standard.

---

## Implementation Gate

This document describes the design. **Do not implement until:**
- [ ] PRs #26-#39 merged to main in `bettercallzaal/zol`
- [ ] ZOL agent-gateway confirmed running on Pi (`curl localhost:8089/health` → `{"ok":true}`)
- [ ] Zaal answers Q1-Q4 above
- [ ] Brandon reviews this design (as with PR #29)

Once gates are cleared, implementation is:
- **ZOE side (~1 day):** New file `zao-os/bot/src/zoe/intent-router.ts` + wiring in `index.ts`
- **ZOL side (~0.5 day):** New `board.zol-intent.claim` handler + update `detect-work-intent` loop

---

*No private DreamNet repository was accessed in producing this design.*
*No production changes occur until Zaal clears the implementation gate above.*
