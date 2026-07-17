# ZOL v2 Stack Review — #26/#27/#28 + #60 (for Brandon)

**Date:** 2026-07-17  
**Branch tip:** `ws/v2-hardening-real` (PR #60)  
**Hard gate:** `npm test` → **546 / 76 suites / 546 pass / 0 fail**

---

## What each PR does

### PR #26 — Core infrastructure (merge first)
`ws/v2-core-layers` → `main`

Layers 1, 2, 5–8, 11: the durable runtime foundation.

- **CapsuleRegistry** — install, validate (SHA-256), activate, disable, rollback
- **DreamLoopRegistry** — load JSON/YAML manifests, validate deterministic contracts
- **MemoryWeaver** — working/episodic/relationship/project/source memory with provenance, dedup, contradiction flags, freshness, private/public boundaries
- **WorkRouter** — classify conversation vs. real work; create/route/checkpoint/resume/complete work packets; auto-generates `sideEffectKey` per packet (idempotency)
- **ModelGateway** — OpenRouter + optional Ollama; quota, timeout/fallback, redacted telemetry; tier routing (cheap/standard/frontier → haiku/sonnet/opus)
- **ToolGateway** — typed registry, capability discovery, permission checks, approval gating, receipts for every consequential call; `idempotencyKey` deduplicates consequential tools
- **ReceiptJournal** — SHA-256 chained receipts, idempotency keys, secret-stripped evidence, linked receipt chain

Handler layer (`src/handlers/index.js`) wires `state.local.*`, `memory.*`, `receipt.local.*` to real implementations in non-mock mode.

10 required capsules present. 31 loops.

---

### PR #27 — Agent gateway, artifact pipeline, knowledge products
`ws/v2-layer-9-12-gateway` → `#26`

Layers 9, 12, 14, 15 and the three knowledge products.

- **ArtifactPipeline** — plan → build → verify → package → deliver; secret-stripping; semver patch bump on rebuild; trapper bundle export
- **AgentGateway** — localhost-only HTTP (127.0.0.1:8089); all 11 spec endpoints + MCP tool surface; token-bucket rate limiting; no public exposure
- **ProofDropAdapter** — sanitised receipt+evidence bundle; strips prompts, private memory, secrets before returning; `validate()` confirms no leaks
- **ToolGymAdapter** — training manifests, bounded workouts, pass-rate computation; mastery receipts attested as `'toolgym-adapter'` (never self-certifying)
- **Zictionary / Zocuments / Zikipedia** — sourced glossary, doc store, approval-gated wiki; all edit operations block/invalidate on `status='approved'`

Full spec deliverables doc: `docs/v2-deliverables.md`.

---

### PR #28 — Remaining DreamLoops, ApprovalBridge, integration suite
`ws/v2-integration-loops` → `#27`

Completes the required 45-loop set. Layer 10.

- **10 missing DreamLoops** — `bootstrap-state-v1`, `heartbeat-v1`, `restart-recovery-v1`, `resume-work-v1`, `source-citation-v1`, `request-approval-v1`, `open-trapper-v1`, `capability-gap-analysis-v1`, `component-watch-v1`, `improvement-proposal-v1`
- **ApprovalBridge** — extends the existing Telegram authority with a durable queue. Idempotent. Lifecycle: `pending → approved / denied / timeout / cancelled`. Auto-expiry. Fails CLOSED on error or timeout. Does NOT create a competing approval system.
- **Integration test suite** — `src/__tests__/real-backend.test.js` Tests 1–11: live AgentGateway on port 0, fresh AtomicFileStore; covers partial completion, approval timeout, stale lease reclaim

---

### PR #60 — Hardening correction (makes the gate real)
`ws/v2-hardening-real` → `#59` (stacks atop the full 34-PR chain)

Three root-cause bugs fixed + `npm test` wired to the full suite:

| Bug | Root cause | Fix |
|-----|-----------|-----|
| Live state was a no-op | `createStateStore()` is async; old code stored the unresolved Promise, so all live-mode ops silently fell through to mock | `_stateStorePromise` pattern; all callers `await getStateStore()` |
| Write failure looked like success | `state.local.write` had a silent `{ written: true }` fallback on live-mode error | Fail-closed: returns `{ written: false, error }` |
| Abort fired as uncaughtException | `signal.addEventListener('abort', () => { throw })` throws inside the EventTarget implementation, not in the async try/catch | `Promise.race([storeP, abortP])` pattern |

`npm test` previously ran only the 14 calendar tests (`test/`). Wired to full suite (`test/ + vendor/dreamloops/... + src/__tests__/... + src/handlers/__tests__/...`).

---

## Recovery tests — all 7 passing

`node --test src/__tests__/real-backend.test.js` → **17 / 0 fail**

| Test | Scenario |
|------|----------|
| 9 | Partial completion — work packet checkpoint survives mid-loop crash |
| 10 | Approval timeout — ApprovalBridge transitions to `timeout`, action denied |
| 11 | Stale lease reclaim — expired `leased_until` reclaimed by second claimer |
| 12 | Trapper round-trip — export/import survives AgentGateway lifecycle |
| 13 | run_loop MCP status — returns `validated`, not `queued` |
| 14 | Duplicate execution — `idempotencyKey` causes handler to run exactly once |
| 15 | Supervisor restart — artifact persists across AgentGateway stop + new instance |
| 16 | Memory outage — `MemoryWeaver.write()` with broken store propagates typed Error |
| 17 | Receipt-write failure — `ReceiptJournal.append()` with broken store propagates typed Error |

---

## Hard acceptance gate

```
npm test

# tests 546
# suites 76
# pass 546
# fail 0
# duration_ms ~15000
```

```
npm run dl:test

# pass 532
# fail 0
# duration_ms ~6000
```

---

## Merge order

```
#26 → #27 → #28 → #31 → #32 → #33 → #34 → #35 → #36 → #37
  → #38 → #39 → #43 → #44 → #45 → #46 → #47 → #48 → #49 → #50
  → #51 → #52 → #53 → #54 → #55 → #56 → #57 → #58 → #59 → #60
```

Standalones (merge any time): **#41** (CI), **#40** (Keystone 3 design), **#42** (Keystone 4 design)

After #26–#60 merge: follow `docs/pi-activation-runbook-v1.md` for Pi activation.

---

## Safety invariants (unchanged)

- No wallet, signer, token, or on-chain action added
- No public post or Telegram message sent by any test
- No secrets in Git, logs, fixtures, or test fixtures
- Telegram remains sole human approval authority
- Warper Keeper wired through disabled/mock adapter only
- No private DreamNet repository accessed
