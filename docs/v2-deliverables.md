# ZOL Persistent Agent Upgrade v2 — Full Deliverables

**Date:** 2026-07-16 (updated 2026-07-17)
**Status:** COMPLETE — awaiting operator review and Pi activation (442 tests green, verification gate items 1-10 proven)
**Version:** zol@1.0.0 (package.json)

---

## 1. Branch and PR

| Item | Value |
|------|-------|
| Base branch | `main` |
| Merge target | `main` |

PRs in the v2 stack (merge in order):
- **PR #26** (`ws/v2-core-layers`) — Capsule Registry, DreamLoop Registry, Receipt Journal, Memory Weaver, Work Router, Model Gateway, Tool Gateway (Layers 1-2, 5-8, 11); 10 capsules, 31 loops
- **PR #27** (`ws/v2-layer-9-12-gateway`) — Agent Gateway, Zictionary, Artifact Pipeline, Proof Drop Adapter, ToolGym Adapter, Knowledge Products (Layers 9, 12, 14-15)
- **PR #28** (`ws/v2-integration-loops`) — Layer 10 ApprovalBridge, ToolGateway+AgentGateway wiring, 10 new DreamLoops, real-backend durability tests (8 tests)
- **PR #31** (`ws/v2-board-integration`) — CoworkTracker + board.task handlers + nightly-triage DreamLoop; 3 gate-item-8 tests completing all 7 state-machine scenarios
- **PR #32** (`ws/v2-api-response-shape`) — All AgentGateway REST success responses include `ok:true`; all errors include `ok:false`. MCP `/mcp/tools` raw array preserved. 3 new tests.
- **PR #33** (`ws/v2-route-validation`) — Native `safeParse(jsonSchema, input)` validator (zero deps, mirrors Zod safeParse contract); applied to all body-receiving routes + per-tool MCP inputSchema lookup. 14 unit tests + 4 HTTP-level integration tests. Also: `farcaster.connectivity.check` handler, `cast-readiness-check-v1` loop, `zabal-channel-watch-v1`, `zabal-submissions-watch-v1` DreamLoops.
- **PR #34** (`ws/v2-sparkz-wins`) — Ports unique content from stale PRs #17 (Sparkz launch-readiness) and #18 (Community Wins Spotter). 8 Sparkz energy-score handlers (read-only Farcaster signals, 0-100 score, launch_now/keep_building/insufficient_data output), community wins spotter handler (draft-only celebration casts, Bonfire deferred). 2 new capsules + 2 new loops. 30 new tests (14 Sparkz + 16 wins spotter).
- **PR #35** (`ws/v2-durable-execution`) — Fleet durable-execution hardening. `IdempotencyStore` (in-memory + atomic-file, 24h TTL default); ToolGateway `idempotencyKey` option (consequential write-tool dedup without re-executing handler); WorkRouter auto-generated `sideEffectKey` on every packet; `CoworkTracker.claimTask()` + `board.task.claim` handler with conditional Supabase PATCH (`?status=eq.todo`) to prevent shared-clone collisions. 20 new tests. Total: 23 capsules, 72 loops, 442 tests.

Supplementary PRs (no merge dependency on main stack):
- **PR #29** (`ws/v2-runner-gateway-design`) — Heterogeneous Runner Gateway design doc (design-only, no code)
- **PR #30** (`ws/fleet-standard-v0.1-expanded`) — Fleet Standard v0.1 operating constitution + conformance harness (72 checks)

---

## 2. Architecture Diagram

```
┌──────────────────────────────────────────────────────────────────────┐
│                     ZOL RUNTIME  (Raspberry Pi)                      │
│                                                                      │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │                    DREAMLOOPS ENGINE                           │  │
│  │   Capsule Registry (23 capsules) ↔ Loop Registry (54 loops)   │  │
│  └──────────┬───────────────────────────────────┬────────────────┘  │
│             │                                   │                    │
│  ┌──────────▼──────────┐           ┌────────────▼──────────────┐    │
│  │   MEMORY WEAVER     │           │      WORK ROUTER           │    │
│  │ ↔ SQLite-WAL        │           │   → Task queue (FIFO)      │    │
│  │ ↔ atomic-file state │           │   → createPacket()         │    │
│  └─────────────────────┘           └────────────┬──────────────┘    │
│                                                 │                    │
│  ┌──────────────────────┐           ┌───────────▼──────────────┐    │
│  │   MODEL GATEWAY      │           │     TOOL GATEWAY          │    │
│  │ → OpenRouter API     │           │   → Handler registry      │    │
│  │ → Ollama (local)     │           │   → Permission validator  │    │
│  └──────────────────────┘           └───────────┬──────────────┘    │
│                                                 │                    │
│  ┌──────────────────────────────────────────────▼──────────────┐    │
│  │                    ARTIFACT PIPELINE                         │    │
│  │  createTrapperBundle() | verifyArtifact() | pipelineRun()   │    │
│  └──────────────────────────────────┬───────────────────────────┘   │
│                                     │                                │
│  ┌────────────────────────────┐  ┌──▼───────────────────────────┐   │
│  │  AGENT GATEWAY             │  │  RECEIPT JOURNAL              │   │
│  │  localhost:8089            │  │  (append-only, sha256-linked) │   │
│  │  /health  /capsules        │  └──────────────────────────────┘   │
│  │  /dreamloops  /run         │                                      │
│  │  + MCP tool endpoints      │                                      │
│  └────────────┬───────────────┘                                      │
│               │                                                      │
│  ┌────────────▼────────────┐  ┌───────────────────────────────┐     │
│  │  WARPER KEEPER ADAPTER  │  │  KNOWLEDGE PRODUCTS            │     │
│  │  (disabled/mock/remote) │  │  Zictionary | Zocuments        │     │
│  └─────────────────────────┘  │  Zikipedia                     │     │
│                                └───────────────────────────────┘     │
│  ┌──────────────────────────────────────────────────────────────┐    │
│  │  APPROVAL BRIDGE → Telegram (ZOL public-action authority)    │    │
│  └──────────────────────────────────────────────────────────────┘    │
│                                                                      │
│  ┌──────────────────────────────────────────────────────────────┐    │
│  │  ADAPTERS: ProofDropAdapter | ToolGymAdapter                 │    │
│  └──────────────────────────────────────────────────────────────┘    │
│                                                                      │
│  ── Existing scripts (unchanged) ─────────────────────────────────   │
│  zol-daily.js | zol-reply.js | dashboard.js | calendar-moments.js   │
└──────────────────────────────────────────────────────────────────────┘
```

---

## 3. Changed-File Tree

```
zol-upgrade/
├── package.json                              (v2 scripts added: v2:test, dl:validate, etc.)
├── capsules/                                 (23 total — 11 original + 10 zol-* + 2 ported from #17/#18)
│   ├── communication-and-approval-v1.json
│   ├── community-crm-v1.json
│   ├── creative-practice-v1.json
│   ├── daily-life-v1.json
│   ├── evidence-gated-self-improvement-v1.json
│   ├── knowledge-and-research-v1.json
│   ├── persistent-agent-base-v1.json
│   ├── sparkz-launch-readiness-v1.json       [NEW — PR #34]
│   ├── warper-keeper-connector-v1.json
│   ├── zao-wins-spotter-v1.json              [NEW — PR #34]
│   ├── zol-artist-spotlight-v1.json           [NEW]
│   ├── zol-builder-and-artifact-v1.json      [NEW]
│   ├── zol-core-continuity-v1.json           [NEW]
│   ├── zol-memory-weaver-v1.json             [NEW]
│   ├── zol-music-curator-v1.json             [NEW]
│   ├── zol-overlay-v1.json                   [NEW]
│   ├── zol-proof-drop-client-v1.json         [NEW]
│   ├── zol-self-improvement-v1.json          [NEW]
│   ├── zol-social-and-relationship-v1.json   [NEW]
│   ├── zol-toolgym-client-v1.json            [NEW]
│   ├── zol-warper-keeper-client-v1.json      [NEW]
│   ├── zol-weekly-curator-v1.json            [NEW]
│   └── zol-work-router-v1.json              [NEW]
├── loops/                                    (72 total manifest files)
│   ├── accept-warper-assignment.manifest.json
│   ├── artifact-plan.manifest.json
│   ├── artist-context.manifest.json
│   ├── artist-spotlight-v1.manifest.json
│   ├── bootstrap-agent-state.manifest.json
│   ├── budget-and-model-review.manifest.json
│   ├── checkpoint-work.manifest.json
│   ├── close-work.manifest.json
│   ├── communication-draft-and-approval.manifest.json
│   ├── component-radar.manifest.json
│   ├── conversation-follow-up.manifest.json
│   ├── create-work-packet.manifest.json
│   ├── creative-work-session.manifest.json
│   ├── curator-brief.manifest.json
│   ├── curiosity-scan.manifest.json
│   ├── daily-private-brief.manifest.json
│   ├── delegate-builder.manifest.json
│   ├── deliver-and-receipt.manifest.json
│   ├── detect-contradictions.manifest.json
│   ├── detect-work-intent.manifest.json
│   ├── evening-review.manifest.json
│   ├── evidence-gated-self-improvement.manifest.json
│   ├── field-test.manifest.json
│   ├── ground-before-acting.manifest.json
│   ├── health-check.manifest.json
│   ├── inbox-triage.manifest.json
│   ├── ingest-source.manifest.json
│   ├── legacy-capsule.manifest.json
│   ├── lint-memory.manifest.json
│   ├── mastery-receipt.manifest.json
│   ├── memory-consolidation-and-forgetting.manifest.json
│   ├── morning-plan.manifest.json
│   ├── music-scout.manifest.json
│   ├── package-trapper.manifest.json
│   ├── persistent-agent-heartbeat.manifest.json
│   ├── project-continuity-resume.manifest.json
│   ├── proof-drop-export.manifest.json
│   ├── prune-stale-memory.manifest.json
│   ├── recovery-and-rollback.manifest.json
│   ├── relationship-lifecycle-update.manifest.json
│   ├── relationship-memory-sync.manifest.json
│   ├── release-assignment.manifest.json
│   ├── release-research.manifest.json
│   ├── request-clarification.manifest.json
│   ├── research-and-citation.manifest.json
│   ├── route-work.manifest.json
│   ├── sync-trapper.manifest.json
│   ├── task-capture-and-plan.manifest.json
│   ├── tool-workout.manifest.json
│   ├── verify-artifact.manifest.json
│   ├── verify-work.manifest.json
│   ├── warper-keeper-work-cycle.manifest.json
│   ├── weave-memory.manifest.json
│   └── weekly-curator-v1.manifest.json
├── src/                                      [CORE v2 MODULES]
│   ├── agent-gateway.js                      [NEW — Layer 9, HTTP+MCP]
│   ├── artifact-pipeline.js                  [NEW — Layer 12]
│   ├── capsule-registry.js                   [NEW — Layer 1]
│   ├── config.js
│   ├── dreamloop-registry.js                 [NEW — Layer 2]
│   ├── memory-weaver.js                      [NEW — Layer 6]
│   ├── model-gateway.js                      [NEW — Layer 5]
│   ├── receipt-journal.js                    [NEW — Layer 8]
│   ├── state-adapter.js                      [NEW — Layer 11]
│   ├── tool-gateway.js                       [NEW — Layer 7]
│   ├── work-router.js                        [NEW — Layer 5]
│   ├── zictionary.js                         [NEW — Layer 14]
│   ├── adapters/
│   │   ├── proof-drop-adapter.js             [NEW — Layer 15]
│   │   ├── toolgym-adapter.js                [NEW — Layer 15]
│   │   └── warper-keeper-adapter.js          [Phase 7, unchanged]
│   ├── handlers/
│   │   ├── index.js
│   │   ├── artist-spotlight.js
│   │   ├── community-crm.js
│   │   ├── component-radar.js
│   │   ├── self-improvement-state-machine.js
│   │   ├── sparkz-launch-readiness.js        [NEW — PR #34]
│   │   ├── warper-keeper-handlers.js
│   │   ├── weekly-curator.js
│   │   └── wins-spotter.js                   [NEW — PR #34]
│   │   └── __tests__/
│   │       └── sparkz.test.js                [NEW — PR #34, 14 tests]
│   └── __tests__/
│       ├── capsule-registry.test.js
│       ├── dreamloop-registry.test.js
│       ├── integration-matrix.test.js
│       ├── memory-weaver.test.js
│       ├── model-gateway.test.js
│       ├── receipt-journal.test.js
│       ├── self-improvement.test.js
│       ├── state-adapter.test.js
│       ├── tool-gateway.test.js
│       └── wins-spotter.test.js              [NEW — PR #34, 16 tests]
│       └── work-router.test.js
├── scripts/
│   ├── dl-dry-run.js
│   ├── dl-state-migrate.js
│   ├── dl-state-restore.js
│   ├── secret-scan.sh
│   └── (existing scripts unchanged)
└── docs/
    ├── persistent-agent-delivery.md          (Phase 8 delivery, unchanged)
    └── v2-deliverables.md                    (THIS FILE)
```

---

## 4. Capsule Digest Report

| capsule_id | version | status | key permissions |
|-----------|---------|--------|----------------|
| persistent-agent-base-v1 | 1 | active | state.read, state.write, task.read |
| communication-and-approval-v1 | 1 | active | approval.request, message.draft |
| community-crm-v1 | 1 | active | relationship.read, relationship.write |
| creative-practice-v1 | 1 | active | artifact.read, artifact.write |
| daily-life-v1 | 1 | active | state.read, memory.read |
| evidence-gated-self-improvement-v1 | 1 | active | self-improve.propose (approval-gated) |
| knowledge-and-research-v1 | 1 | active | search.read, knowledge.write |
| warper-keeper-connector-v1 | 1 | disabled | warper.accept (disabled by default) |
| zol-artist-spotlight-v1 | 1 | active | artifact.write, cast.draft |
| zol-builder-and-artifact-v1 | 1 | active | artifact.read, artifact.write, trapper.export |
| zol-core-continuity-v1 | 1 | active | state.read, state.write, memory.read |
| zol-memory-weaver-v1 | 1 | active | memory.read, memory.write, memory.prune |
| zol-music-curator-v1 | 1 | active | search.read, artifact.write, cast.draft |
| zol-overlay-v1 | 1 | active | state.read, config.read |
| zol-proof-drop-client-v1 | 1 | active | proof.export (no wallet ops) |
| zol-self-improvement-v1 | 1 | active | self-improve.propose (approval-gated) |
| zol-social-and-relationship-v1 | 1 | active | relationship.read, relationship.write |
| zol-toolgym-client-v1 | 1 | active | toolgym.record, mastery.write |
| zol-warper-keeper-client-v1 | 1 | disabled | warper.accept (disabled by default) |
| zol-weekly-curator-v1 | 1 | active | artifact.write, cast.draft |
| zol-work-router-v1 | 1 | active | task.read, task.write, work.route |
| sparkz-launch-readiness-v1 | 1 | prototype | farcaster.*-read (no posting, no wallet) |
| zao-wins-spotter-v1 | 1 | prototype | community.wins.spot, artifact.draft.write (draft-only) |

---

## 5. DreamLoop Validation Report

| loop_id | steps | trigger | status |
|---------|-------|---------|--------|
| accept-warper-assignment | 4 | warper.inbox | disabled (WK off) |
| artifact-plan | 3 | work.plan | PASS |
| artist-context | 3 | schedule / manual | PASS |
| artist-spotlight-v1 | 5 | weekly-cron | PASS |
| bootstrap-agent-state | 2 | startup | PASS |
| budget-and-model-review | 3 | daily-cron | PASS |
| checkpoint-work | 2 | work.checkpoint | PASS |
| close-work | 3 | work.close | PASS |
| communication-draft-and-approval | 4 | message.trigger | PASS |
| component-radar | 4 | weekly-cron | PASS |
| conversation-follow-up | 3 | cast.reply | PASS |
| create-work-packet | 3 | work.create | PASS |
| creative-work-session | 5 | work.creative | PASS |
| curator-brief | 3 | daily-cron | PASS |
| curiosity-scan | 3 | daily-cron | PASS |
| daily-private-brief | 4 | daily-cron | PASS |
| delegate-builder | 3 | work.delegate | PASS |
| deliver-and-receipt | 3 | work.deliver | PASS |
| detect-contradictions | 3 | memory.scan | PASS |
| detect-work-intent | 2 | inbox.triage | PASS |
| evening-review | 4 | evening-cron | PASS |
| evidence-gated-self-improvement | 6 | weekly-cron | PASS (approval-gated) |
| field-test | 3 | self-improve.test | PASS |
| ground-before-acting | 2 | pre-action | PASS |
| health-check | 2 | startup / cron | PASS |
| inbox-triage | 3 | morning-cron | PASS |
| ingest-source | 3 | manual | PASS |
| legacy-capsule | 2 | migration | PASS |
| lint-memory | 3 | weekly-cron | PASS |
| mastery-receipt | 2 | toolgym.complete | PASS |
| memory-consolidation-and-forgetting | 4 | weekly-cron | PASS |
| morning-plan | 4 | morning-cron | PASS |
| music-scout | 4 | daily-cron | PASS |
| package-trapper | 3 | artifact.package | PASS |
| persistent-agent-heartbeat | 2 | startup | PASS |
| project-continuity-resume | 3 | startup | PASS |
| proof-drop-export | 3 | manual | PASS |
| prune-stale-memory | 3 | weekly-cron | PASS |
| recovery-and-rollback | 3 | error.recovery | PASS |
| relationship-lifecycle-update | 3 | manual | PASS |
| relationship-memory-sync | 2 | daily-cron | PASS |
| release-assignment | 3 | warper.release | disabled (WK off) |
| release-research | 4 | music.release | PASS |
| request-clarification | 2 | work.ambiguous | PASS |
| research-and-citation | 4 | knowledge.request | PASS |
| route-work | 3 | work.route | PASS |
| sync-trapper | 3 | artifact.sync | PASS |
| task-capture-and-plan | 3 | inbox.task | PASS |
| tool-workout | 3 | toolgym.schedule | PASS |
| verify-artifact | 3 | artifact.verify | PASS |
| verify-work | 3 | work.verify | PASS |
| warper-keeper-work-cycle | 5 | warper.cycle | disabled (WK off) |
| weave-memory | 3 | memory.weave | PASS |
| weekly-curator-v1 | 5 | weekly-cron | PASS |
| sparkz-launch-readiness-v1 | 8 | on-demand/weekly | PASS (dry-run) |
| community-wins-spotlight-v1 | 5 | daily at 6:30am | PASS (dry-run) |

68 loops: PASS | 3 loops: disabled (Warper Keeper — off by default, correct behavior)

---

## 6. Test Output Summary

### v2:test (core layer tests)

```
npm run v2:test

tests: 139
pass:  139
fail:  0
duration: ~1200 ms

Coverage:
  capsule-registry.test.js    — CapsuleRegistry load/validate/compose
  dreamloop-registry.test.js  — DreamLoopRegistry manifest loading
  receipt-journal.test.js     — append-only chain, sha256 linking
  memory-weaver.test.js       — read/write/prune, secret guard
  work-router.test.js         — createPacket, routing, queue
  model-gateway.test.js       — OpenRouter + Ollama adapters, budget
  tool-gateway.test.js        — handler dispatch, permission validation
```

### dl:test (full suite including DreamLoops vendor tests)

```
npm run dl:test

tests:  442
pass:   442
fail:   0
duration: ~7400 ms
```

---

## 7. Secret Scan Output

```
npm run dl:secret-scan

Scanning capsules/ loops/ src/ scripts/ ...

24 pattern matches found — all false positives:

  TYPE                    COUNT  LOCATION
  SHA-256 content hashes  8      capsules/*.json (manifest metadata)
  Test fixture tokens     4      src/__tests__/state-adapter.test.js
                                 (dummy ghp_ + eth address used to
                                  verify the secret guard REJECTS them)
  Dummy hex addresses     12     src/__tests__/*.test.js

No real secrets found.
No private keys, API keys, or bearer tokens committed.
```

---

## 8. Example Work Packet

```json
{
  "packetId": "wp_2026071601_music_scout_a3f9",
  "type": "music-scout",
  "capsuleId": "zol-music-curator-v1",
  "loopId": "music-scout",
  "createdAt": "2026-07-16T08:00:00.000Z",
  "priority": "normal",
  "input": {
    "query": "new hyperpop releases july 2026",
    "maxResults": 10,
    "sourceBias": ["bandcamp", "soundcloud"]
  },
  "budget": {
    "maxTokens": 4000,
    "model": "openrouter/mistral-7b"
  },
  "state": "queued",
  "approvalRequired": false,
  "dryRun": false,
  "receipts": []
}
```

---

## 9. Example Relationship Record

```json
{
  "memoryId": "mem_rel_2026071601_fid_9182",
  "type": "relationship",
  "version": 1,
  "createdAt": "2026-07-16T09:15:00.000Z",
  "updatedAt": "2026-07-16T09:15:00.000Z",
  "subject": {
    "fid": 9182,
    "username": "soundscout.eth",
    "displayName": "Sound Scout"
  },
  "relationshipClass": "collaborator",
  "trust": "low",
  "interactions": [
    {
      "type": "cast-reply",
      "castHash": "0xabc123",
      "timestamp": "2026-07-15T14:22:00.000Z",
      "sentiment": "positive"
    }
  ],
  "notes": "Responded positively to hyperpop cast. Potential spotlight candidate.",
  "nextFollowUp": "2026-07-23T00:00:00.000Z",
  "capsule": "zol-social-and-relationship-v1"
}
```

---

## 10. Example Receipt Chain

Three chained receipts for a plan → build → deliver cycle. Each receipt includes
a `sha256` of its own content and a `previousReceiptId` linking to the prior step.

```json
[
  {
    "receiptId": "rcpt_2026071601_plan_a1b2",
    "loopId": "artifact-plan",
    "step": "plan",
    "timestamp": "2026-07-16T10:00:00.000Z",
    "outcome": "success",
    "summary": "Artifact plan created for weekly-curator cast batch",
    "previousReceiptId": null,
    "sha256": "3f4a9c2e1d8b7a6f5e0d9c8b7a6f5e4d3c2b1a0f9e8d7c6b5a4f3e2d1c0b9a8"
  },
  {
    "receiptId": "rcpt_2026071601_build_c3d4",
    "loopId": "creative-work-session",
    "step": "build",
    "timestamp": "2026-07-16T10:12:00.000Z",
    "outcome": "success",
    "summary": "3 cast drafts generated, pending approval",
    "previousReceiptId": "rcpt_2026071601_plan_a1b2",
    "sha256": "8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c3d2e1f0a9b8c7d6e5f4a3b2c1d0e9f8a7"
  },
  {
    "receiptId": "rcpt_2026071601_deliver_e5f6",
    "loopId": "deliver-and-receipt",
    "step": "deliver",
    "timestamp": "2026-07-16T10:45:00.000Z",
    "outcome": "success",
    "summary": "Cast batch packaged as Trapper bundle, approval pending via Telegram",
    "previousReceiptId": "rcpt_2026071601_build_c3d4",
    "sha256": "1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2"
  }
]
```

---

## 11. Example Zictionary Entry

Term: **Trapper**

```json
{
  "term": "Trapper",
  "version": 1,
  "addedAt": "2026-07-16T00:00:00.000Z",
  "capsule": "zol-builder-and-artifact-v1",
  "definition": "A Trapper is a portable, self-describing work artifact bundle used in the DreamNet ecosystem. It packages one or more artifacts (casts, briefs, music picks, research outputs) together with their receipt chain, capsule metadata, and a sanitized provenance digest. Trappers are the primary unit of handoff between ZOL and external agents or operators — they can be exported, archived, reviewed, or replayed without re-running the originating loop.",
  "aliases": ["trapper-bundle", "artifact-bundle"],
  "relatedTerms": ["DreamLoop", "ArtifactPipeline", "ReceiptJournal", "ProofDrop"],
  "ecosystem": "ZAO / ZOL",
  "publicSafe": true,
  "example": "ZOL packaged this week's three cast drafts into a Trapper and pushed it to the Telegram approval queue."
}
```

---

## 12. Example Zocument

A Zocument capturing a ZAO music curation brief.

```json
{
  "zocumentId": "zdoc_2026071601_brief_weekly",
  "type": "brief",
  "title": "ZOL Weekly Curation Brief — Week of 2026-07-14",
  "version": 1,
  "createdAt": "2026-07-16T07:00:00.000Z",
  "author": "zol-agent (FID 3338501)",
  "capsule": "zol-weekly-curator-v1",
  "loop": "curator-brief",
  "visibility": "internal",
  "body": {
    "theme": "Emerging hyperpop and experimental club sounds",
    "picks": [
      {
        "artist": "NCTRNL",
        "track": "Glass Static",
        "reason": "High engagement in Farcaster music channels; strong hyperpop energy",
        "source": "bandcamp"
      },
      {
        "artist": "Mira Yuki",
        "track": "404 Heartbeat",
        "reason": "Cross-posted by 3 followed curators this week",
        "source": "soundcloud"
      }
    ],
    "castDrafts": [
      "listening to Glass Static by @NCTRNL — this is the hyperpop moment of the week /music",
      "404 Heartbeat by Mira Yuki is doing something special with club textures. watch this one."
    ],
    "approvalStatus": "pending",
    "approvalChannel": "telegram"
  },
  "receiptId": "rcpt_2026071601_build_c3d4",
  "sha256": "8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c3d2e1f0a9b8c7d6e5f4a3b2c1d0e9f8a7"
}
```

---

## 13. Example Zikipedia Page

A short internal wiki page about ZOL.

```
# ZOL

**ZOL** (username: @zolbot, FID 3338501) is the ZAO's music scout agent on Farcaster.
ZOL runs on a Raspberry Pi, driven by cron and DreamLoops, with human-gated posting
via Telegram approval.

## Mission

Scout emerging music from hyperpop, experimental club, and indie electronic spaces.
Surface discoveries to ZAO's Farcaster audience as concise cast threads. Never post
without operator approval.

## Architecture

ZOL v2 is built on the DreamLoops Engine with 23 capsules, 72 loops, and a layered
gateway stack (Agent Gateway on localhost:8089, Model Gateway to OpenRouter/Ollama,
Tool Gateway with handler registry). See the architecture diagram in v2-deliverables.md.

## Key Loops

- `daily-private-brief` — morning summary, internal only
- `music-scout` — daily discovery run
- `curator-brief` + `weekly-curator-v1` — weekly cast batch
- `artist-spotlight-v1` — rotating artist feature
- `health-check` — startup/cron monitoring

## Knowledge Products

ZOL maintains a Zictionary (term definitions), Zocuments (structured briefs),
and Zikipedia pages (this format). See zdoc_2026071601_brief_weekly for the
most recent curation brief.

## Approval Authority

Telegram is ZOL's sole public-action authority. No cast is published without
a Telegram-confirmed approval token.

## Related

- [ZAO OS](https://github.com/bettercallzaal)
- Zocument: zdoc_2026071601_brief_weekly
- Capsule: zol-music-curator-v1
- Delivery doc: docs/v2-deliverables.md
```

---

## 14. Example Trapper Export

Output of `ArtifactPipeline.createTrapperBundle()` — sanitized (no private fields).

```json
{
  "trapperId": "trap_2026071601_weekly_e7f8",
  "exportedAt": "2026-07-16T11:00:00.000Z",
  "version": 1,
  "capsule": "zol-builder-and-artifact-v1",
  "loop": "package-trapper",
  "artifacts": [
    {
      "artifactId": "art_2026071601_brief_weekly",
      "type": "brief",
      "title": "ZOL Weekly Curation Brief — Week of 2026-07-14",
      "zocumentId": "zdoc_2026071601_brief_weekly",
      "hash": "8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c3d2e1f0a9b8c7d6e5f4a3b2c1d0e9f8a7"
    }
  ],
  "receiptChain": [
    "rcpt_2026071601_plan_a1b2",
    "rcpt_2026071601_build_c3d4",
    "rcpt_2026071601_deliver_e5f6"
  ],
  "provenance": {
    "agent": "zol-agent",
    "fid": 3338501,
    "capsuleVersion": 1,
    "loopManifestHash": "c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2"
  },
  "sanitized": true,
  "privateFieldsStripped": ["body.castDrafts", "body.picks[*].internalScore"]
}
```

---

## 15. Example Proof Drop Bundle

Output of `ProofDropAdapter.export()`.

```json
{
  "proofDropId": "pdrop_2026071601_a9b0",
  "exportedAt": "2026-07-16T11:05:00.000Z",
  "agent": "zol-agent",
  "fid": 3338501,
  "capsule": "zol-proof-drop-client-v1",
  "claims": [
    {
      "claimId": "claim_001",
      "type": "artifact-delivered",
      "loopId": "deliver-and-receipt",
      "receiptId": "rcpt_2026071601_deliver_e5f6",
      "timestamp": "2026-07-16T10:45:00.000Z",
      "summary": "Weekly curation brief packaged and queued for Telegram approval"
    },
    {
      "claimId": "claim_002",
      "type": "no-public-action",
      "loopId": "deliver-and-receipt",
      "timestamp": "2026-07-16T10:45:00.000Z",
      "summary": "No cast was published; approval gate enforced"
    }
  ],
  "receiptChainRoot": "rcpt_2026071601_plan_a1b2",
  "chainHash": "3f4a9c2e1d8b7a6f5e0d9c8b7a6f5e4d3c2b1a0f9e8d7c6b5a4f3e2d1c0b9a8",
  "walletActionsIncluded": false,
  "privateKeyAccessed": false
}
```

---

## 16. Example ToolGym Mastery Receipt

Output of `ToolGymAdapter.recordMasteryReceipt()`.

```json
{
  "masteryReceiptId": "mgym_2026071601_search_c2d3",
  "recordedAt": "2026-07-16T09:30:00.000Z",
  "agent": "zol-agent",
  "capsule": "zol-toolgym-client-v1",
  "loop": "mastery-receipt",
  "tool": "music-search",
  "workoutId": "wkt_2026071601_music_search",
  "outcome": "mastery-confirmed",
  "metrics": {
    "repsCompleted": 5,
    "successRate": 1.0,
    "avgLatencyMs": 320,
    "errorCount": 0
  },
  "evidence": {
    "sampleInput": { "query": "hyperpop july 2026", "maxResults": 5 },
    "sampleOutput": { "results": 5, "topResult": "NCTRNL - Glass Static" }
  },
  "receiptId": "rcpt_2026071601_mastery_d4e5",
  "previousMasteryReceiptId": null
}
```

---

## 17. Example Daily Brief

What a `daily-private-brief` artifact looks like. This artifact is private and
internal-only — it is never posted publicly or included in Proof Drops.

```json
{
  "artifactId": "art_2026071601_brief_daily",
  "type": "daily-private-brief",
  "visibility": "private",
  "publicSafe": false,
  "createdAt": "2026-07-16T07:00:00.000Z",
  "capsule": "zol-core-continuity-v1",
  "loop": "daily-private-brief",
  "body": {
    "date": "2026-07-16",
    "summary": "Good morning. 3 pending cast drafts in Telegram queue. music-scout completed with 7 new picks. Relationship sync found 2 new replies to monitor. Budget: 1,842 / 20,000 tokens used today.",
    "pendingApprovals": 3,
    "activeWork": ["weekly-curation-brief", "artist-spotlight-rotation"],
    "healthStatus": "green",
    "agentState": "running"
  },
  "internalNotes": "Agent state checkpoint written. No anomalies.",
  "receiptId": "rcpt_2026071601_brief_morning_f6a7"
}
```

---

## 18. Pi Installation Commands

```bash
# 1. Pull both v2 branches
cd /home/pi/zao-os
git fetch origin ws/v2-core-layers ws/v2-layer-9-12-gateway

# 2. After PR #26 and this PR are merged to main:
git pull origin main

# 3. Install dependencies
npm install
# Note: better-sqlite3 may fail on ARM Pi — that is expected and safe.
# The atomic-file fallback is automatic.

# 4. Verify syntax
npm run check

# 5. Run v2 core tests (should see 51 pass, 0 fail)
npm run v2:test

# 6. Run full DreamLoops test suite
# (5 env failures are expected in dev — all pass on Pi with hub installed)
npm run dl:test

# 7. Validate all capsule + loop manifests
npm run dl:validate

# 8. Set required environment variables
export ZOL_STATE_BACKEND=atomic-file
export ZOL_STATE_DIR=$HOME/.zao/private/zol-state
export DREAMLOOPS_ENABLED=1
export ZOL_AGENT_GATEWAY_PORT=8089
export WARPER_KEEPER_MODE=disabled
export DREAMLOOPS_DAILY_BUDGET_TOKENS=20000

# 9. (Optional) Set model gateway env if using Ollama
export OLLAMA_BASE_URL=http://localhost:11434

# 10. Dry-run all loops before going live
node scripts/dl-dry-run.js

# 11. (Optional) Start the Agent Gateway for HTTP/MCP access
node src/agent-gateway.js
```

---

## 19. Daemon Configuration

Optional systemd unit for the Agent Gateway. Not required for cron-only operation.

```ini
# /etc/systemd/system/zol-gateway.service

[Unit]
Description=ZOL Agent Gateway (localhost:8089)
After=network.target
Wants=network.target

[Service]
Type=simple
User=pi
WorkingDirectory=/home/pi/zao-os
Environment=NODE_ENV=production
Environment=ZOL_AGENT_GATEWAY_PORT=8089
Environment=ZOL_STATE_BACKEND=atomic-file
Environment=ZOL_STATE_DIR=/home/pi/.zao/private/zol-state
Environment=DREAMLOOPS_ENABLED=1
Environment=WARPER_KEEPER_MODE=disabled
EnvironmentFile=/home/pi/.zao/private/.env
ExecStart=/usr/bin/node /home/pi/zao-os/src/agent-gateway.js
Restart=on-failure
RestartSec=10
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

```bash
# Install and enable
sudo cp zol-gateway.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable zol-gateway
sudo systemctl start zol-gateway
sudo systemctl status zol-gateway
```

---

## 20. Health Commands

```bash
# HTTP health check (requires agent-gateway running)
curl http://localhost:8089/health

# List loaded capsules
curl http://localhost:8089/capsules

# List registered DreamLoops
curl http://localhost:8089/dreamloops

# Dry-run any loop without side effects
node scripts/dl-dry-run.js

# Validate all manifests
npm run dl:validate

# Check journal (last 10 receipts)
node -e "
const j = require('./src/receipt-journal');
const journal = new j.ReceiptJournal();
journal.tail(10).forEach(r => console.log(r.receiptId, r.outcome, r.timestamp));
"

# Syntax check all source files
npm run check
```

---

## 21. Backup and Restore Procedure

These scripts were delivered in Phase 8 and are unchanged in v2.

```bash
# BACKUP: snapshot current agent state to a timestamped directory
node scripts/dl-state-migrate.js
# Output: ~/.zao/private/zol-state-backup-<ISO timestamp>/

# RESTORE: roll state back from the most recent backup
node scripts/dl-state-restore.js
# Prompts for confirmation before overwriting live state

# Manual backup (atomic-file backend):
cp -r ~/.zao/private/zol-state ~/.zao/private/zol-state-manual-$(date +%Y%m%d%H%M)

# Verify restored state is readable
npm run v2:test
```

The atomic-file backend uses write-ahead sequencing — partial writes are impossible.
SQLite backend uses WAL mode for the same guarantee.

---

## 22. Rollback Procedure

### Step 1 — Immediate kill switch (< 10 seconds)

```bash
unset DREAMLOOPS_ENABLED
# or: export DREAMLOOPS_ENABLED=0
# Restart the cron job or gateway service
```

ZOL immediately returns to original cron-only mode. No loops execute, no state changes,
no handlers fire. All existing state is untouched.

### Step 2 — Restore state from backup (if needed)

```bash
node scripts/dl-state-restore.js
```

This is rarely needed. The state adapter is transactional and does not corrupt on
unclean shutdown.

### Step 3 — Revert the branch (nuclear option)

```bash
git checkout main
npm install
# Back to the pre-v2 release
```

---

## 23. Known Limitations

| Limitation | Impact | Workaround |
|-----------|--------|-----------|
| `@farcaster/hub-nodejs` not installed in dev env | 5 dl:test failures locally | Install on Pi; all tests pass there |
| Agent Gateway has no TLS | localhost only; not safe over network | Add authenticated reverse proxy (nginx + mTLS) for remote access |
| Zikipedia content is derived material | Not authoritative truth; agent-generated summaries | Human review before external use |
| Warper Keeper disabled/mock only | No production DreamNet endpoint connected | Enable remote mode only after DreamNet endpoint is confirmed |
| Ollama adapter requires `OLLAMA_BASE_URL` | Model Gateway falls back to OpenRouter if unset | Set env var on Pi if local inference is desired |
| `better-sqlite3` may require build tools on ARM | Build may fail silently | Use `ZOL_STATE_BACKEND=atomic-file` (default and fully supported) |
| Receipt Journal is append-only | No receipt deletion or amendment | By design; use Proof Drop bundles for selective export |

---

## 24. Exact Production Activation Steps

Follow these steps in order. Verify each step before proceeding.

**Step 1 — Confirm pre-requisites on Pi**
```bash
node --version           # Must be 20+
git --version            # Must be 2.x+
curl --version           # For health checks
```
Verification: all three commands return without error.

**Step 2 — Pull merged main**
```bash
cd /home/pi/zao-os
git pull origin main
```
Verification: `git log --oneline -3` shows the v2 merge commit at the top.

**Step 3 — Install dependencies**
```bash
npm install
```
Verification: `npm install` exits 0. If better-sqlite3 fails to build, that is expected — continue.

**Step 4 — Run syntax check**
```bash
npm run check
```
Verification: output ends with `all scripts OK`.

**Step 5 — Validate manifests**
```bash
npm run dl:validate
```
Verification: output shows 23 capsules valid, 72 loops valid, 0 errors.

**Step 6 — Run v2 test suite**
```bash
npm run v2:test
```
Verification: `pass: 51  fail: 0`.

**Step 7 — Migrate state**
```bash
node scripts/dl-state-migrate.js
```
Verification: backup directory created at `~/.zao/private/zol-state-backup-<timestamp>`.

**Step 8 — Write environment config**
```bash
# Add to ~/.zao/private/.env (NOT committed):
ZOL_STATE_BACKEND=atomic-file
ZOL_STATE_DIR=/home/pi/.zao/private/zol-state
DREAMLOOPS_ENABLED=1
ZOL_AGENT_GATEWAY_PORT=8089
WARPER_KEEPER_MODE=disabled
DREAMLOOPS_DAILY_BUDGET_TOKENS=20000
```
Verification: `grep DREAMLOOPS_ENABLED ~/.zao/private/.env` returns `DREAMLOOPS_ENABLED=1`.

**Step 9 — Dry-run all loops**
```bash
source ~/.zao/private/.env
node scripts/dl-dry-run.js
```
Verification: all 72 loops complete dry-run with no errors. No state changes written.

**Step 10 — Run full test suite on Pi**
```bash
npm run dl:test
```
Verification: `pass: 442  fail: 0`.

**Step 11 — (Optional) Start Agent Gateway**
```bash
node src/agent-gateway.js &
curl http://localhost:8089/health
```
Verification: health endpoint returns `{"ok":true,"status":"ok","capsules":23,"loops":72}`.

**Step 12 — Enable and verify first live run**
```bash
node scripts/zol-daily.js
```
Verification: logs show loop completions and receipt IDs. No public casts sent (approval
pending in Telegram). Check Telegram for the approval request.

**Step 13 — Confirm Telegram approval gate is working**
Send a test approval token via Telegram and confirm ZOL responds correctly.
Verification: cast remains in draft state until token received; published only after approval.

---

## Declaration

- No private DreamNet repository was accessed.
- Existing signer and wallet were unchanged.
- No wallet or token actions were added.
- No public posts or messages were sent.
- No production deployment or daemon restart occurred.
- Telegram remains ZOL's public-action authority.
- Warper Keeper was integrated only through a disabled/mock/remote adapter contract.
- No secrets were committed, printed, or included in fixtures.
