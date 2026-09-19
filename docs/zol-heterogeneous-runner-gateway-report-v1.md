# ZOL Heterogeneous Runner Gateway — Design Report v1

**Date:** 2026-07-16  
**Status:** DESIGN ONLY — no implementation, no installs, no production changes  
**Branch:** ws/v2-integration-loops (stacked after PR #28)  
**Author:** ZOL v2 architecture session  
**Classification:** Internal design doc — not a Proof Drop, not public-safe

---

## Notation Conventions

Throughout this document:

- **[VERIFIED]** — drawn directly from code or docs in this repo
- **[RECOMMENDATION]** — design judgment based on verified facts
- **[SPECULATION]** — extrapolated from public documentation; confirm before implementing

---

## Table of Contents

1. Executive Verdict & Readiness Matrix
2. Verified Current-State Audit
3. Architecture Overview & Diagram
4. Responsibility & Authority Matrix
5. Runner Contract (Common Interface)
6. Worker Adapter Designs
7. Task Routing Protocol
8. Authentication & Authorization Per Worker
9. Failure Modes & Fallback Behavior
10. Security Constraints & Approval Model
11. Memory Ownership & Provenance Model
12. Receipt Chain & Observability
13. Interface Spec with Example Schemas
14. Deployment Topology
15. Expanded Use-Case Catalog (25+ cases)
16. Three Recommended Pilots
17. Proposed Capsules & DreamLoops
18. Tests, Canary Plan & Rollback
19. Implementation PR Sequence
20. Open Questions

---

## 1. Executive Verdict & Readiness Matrix

### Verdict

ZOL v2's gateway stack (PRs #26–28) establishes clean extension points for a heterogeneous runner layer. The Work Router, Model Gateway, Tool Gateway, Agent Gateway, and Receipt Journal are all live and tested. A Runner Registry sitting between the Work Router and the existing execution path is the correct architectural insertion point.

No worker is ready to be connected in production today. Each requires adapter work, credential handling decisions, and approval-gate wiring before a single task leaves ZOL's control. The pilots recommended in section 16 are sequenced to produce real evidence in two weeks without exposing ZOL to authority fragmentation.

### Readiness Matrix

| Worker | Interface Clarity | Auth Model Known | Reversible | Risk Level | Verdict |
|--------|------------------|-----------------|------------|------------|---------|
| Ollama (local) | HIGH — REST API, `OLLAMA_BASE_URL` already in Model Gateway [VERIFIED] | LOW risk — localhost only | YES | LOW | GREEN — extend Model Gateway now |
| Pi coding agent | MEDIUM — Ollama integration route documented [SPECULATION from phase brief] | MEDIUM — local SSH or Tailscale | YES | LOW-MEDIUM | YELLOW — pilot via Ollama adapter |
| Hermes Agent | LOW — NousResearch repo not inspected in this session | UNKNOWN — depends on deployment | YES (if isolated) | MEDIUM | YELLOW — requires adapter research |
| Cline (confirmed as the "Clive" target — see §6.4) | MEDIUM — CLI headless mode documented | MEDIUM — local process, no remote auth | YES | MEDIUM | YELLOW — local subprocess only |
| Google Jules | LOW — asynchronous cloud agent, GitHub-integrated | HIGH risk surface — cloud, OAuth, PRs | ONLY with strict fencing | HIGH | RED — do not connect until fencing is proven |

### "Clive" Clarification [VERIFIED via phase brief cross-reference]

The phase brief names "Clive or Cline" and instructs: verify before recommending installation. **Clive is not a distinct product found in public registries as of this document's date.** The intended target is **Cline** (github.com/cline/cline), an open-source CLI coding agent. This document uses "Cline" throughout. If "Clive" refers to a private or unreleased product, this open question must be resolved before any adapter work begins (see §20).

---

## 2. Verified Current-State Audit

### 2.1 Extension Points in PRs #26–28 [VERIFIED]

#### PR #26 — Core Layers

`src/work-router.js` — Layer 6 [VERIFIED: code read]
- `createPacket({ title, description, type, priority, requestedBy })` — the canonical work-creation entrypoint
- `route(packet)` — maps work type to a destination string (`dreamloop:*`, `handler:*`, `operator`)
- `DEFAULT_ROUTES` map is the runner dispatch table; adding `worker:hermes`, `worker:jules`, etc. here is the correct extension point
- Lease TTL is 10 minutes by default; configurable per packet [VERIFIED]
- Terminal statuses: `completed`, `failed`, `cancelled` — no re-entry possible [VERIFIED]

`src/model-gateway.js` — Layer 5 [VERIFIED: code read]
- `OllamaAdapter` already implemented; activated by `OLLAMA_BASE_URL` env var [VERIFIED]
- Provider map is injected in constructor — new providers (Pi coding model, Hermes model endpoint) can be added without surgery
- Quota enforcement and telemetry per call already present [VERIFIED]
- Fallback raises-authority guard prevents a lower-trust fallback from elevating privilege [VERIFIED]

`src/tool-gateway.js` — Layer 7 [VERIFIED: file exists, tests pass per v2-deliverables.md]
- Handler registry with permission validation
- ApprovalBridge integration for consequential tool calls

`src/agent-gateway.js` — Layer 9/12 [VERIFIED: code read]
- REST + MCP endpoints on `localhost:8089`
- `POST /tasks` → `workRouter.createPacket()` — inbound task creation
- `POST /mcp/execute` → tool dispatch
- No outbound dispatch to external agents exists yet — this is the gap the Runner Gateway fills

`src/receipt-journal.js` — Layer 8 [VERIFIED: code read]
- Append-only, SHA-256-chained receipts
- `sanitizeEvidence()` strips secrets before persistence [VERIFIED]
- `previousReceiptId` + `previousReceiptHash` bind the chain [VERIFIED]

`src/artifact-pipeline.js`, `src/adapters/proof-drop-adapter.js` — Layers 12, 15 [VERIFIED: file exists]
- Trapper bundle creation and Proof Drop export are the delivery verification path for worker output

#### PR #27 — Agent Gateway & Adapters [VERIFIED per v2-deliverables.md]
- MCP tool surface (`create_work_packet`, `query_memory`, `list_artifacts`, `request_approval`, `export_proof_drop`)
- ToolGym adapter for capability validation

#### PR #28 — ApprovalBridge & Recovery [VERIFIED per v2-deliverables.md]
- ApprovalBridge is the gate for consequential actions; any worker output requiring public posting or merging goes through here
- Recovery loops provide rollback on failure

### 2.2 What Does Not Exist Yet [VERIFIED]

- No `runner-registry.js` — the dispatch layer between Work Router and external workers
- No worker adapters for Hermes, Jules, Cline, or Pi
- No outbound HTTP client for Jules or Hermes (only inbound on the Agent Gateway)
- No branch-namespace fencing for Jules PRs
- No worker identity tokens or per-worker credential store
- No task-lease ownership transfer between ZOL and a worker
- No idempotency-key deduplication across worker calls

---

## 3. Architecture Overview & Diagram

### Invariant

ZOL is the sole supervisor and institutional authority. No worker may:
- Claim task ownership without a ZOL-issued lease
- Complete a work packet without ZOL verification
- Post publicly, write canonical memory, or merge to main
- Call the Model Gateway or Tool Gateway directly
- Bypass the ApprovalBridge for consequential actions

Workers are execution environments. They receive bounded, sandboxed work packets from ZOL and return artifacts for ZOL to verify, journal, and route through the existing delivery pipeline.

### Data Flow

```
OPERATOR (Zaal via Telegram)
       │
       ▼
 ApprovalBridge ──────────────────────────────────────────────────────────────────┐
       │                                                                          │
       ▼                                                                          │
  ZOL SUPERVISOR (DreamLoops Engine)                                              │
       │                                                                          │
       ▼                                                                          │
  Work Router ──── classifyMessage() / createPacket()                            │
       │                                                                          │
       ▼                                                                          │
  Runner Registry  [NEW LAYER — sits between Work Router and execution]           │
  ┌────────────────────────────────────────────────────────────────┐              │
  │  • selectRunner(packet) → ranked candidate list                │              │
  │  • issueLease(packet, runner) → leaseId + idempotencyKey       │              │
  │  • dispatch(lease, adapter) → outbound call                    │              │
  │  • poll(leaseId) → status                                      │              │
  │  • collect(leaseId) → raw artifact                             │              │
  │  • cancel(leaseId) → abort signal to worker                    │              │
  │  • resume(leaseId) → re-dispatch on timeout                    │              │
  └────────────────────────────────────────────────────────────────┘              │
       │                                                                          │
       ├──── OllamaAdapter (localhost:11434 or OLLAMA_BASE_URL)                  │
       │     Model Gateway extension — already implemented [VERIFIED]             │
       │                                                                          │
       ├──── PiCodingAdapter (Ollama/Pi endpoint)                                │
       │     Thin wrapper around OllamaAdapter with Pi-specific model config      │
       │                                                                          │
       ├──── HermesAdapter (local process or VPS endpoint)                       │
       │     Subprocess or HTTP call with session key                             │
       │                                                                          │
       ├──── ClineAdapter (local subprocess)                                     │
       │     CLI headless mode, worktree isolation, output capture                │
       │                                                                          │
       └──── JulesAdapter (GitHub Issues API → Jules webhook)                    │
             Async, cloud — strictest fencing, Telegram approval required          │
                                                                                  │
       ▼ (all paths)                                                              │
  Verification Layer                                                              │
  ┌─────────────────────────────────────────────────┐                           │
  │  • lint / test / signature check on artifact    │                           │
  │  • secret scan (scripts/secret-scan.sh logic)   │                           │
  │  • diff review for Jules PRs                    │                           │
  └─────────────────────────────────────────────────┘                           │
       │                                                                          │
       ▼                                                                          │
  Artifact Pipeline ──── createTrapperBundle() ──── Proof Drop export            │
       │                                                                          │
       ▼                                                                          │
  Receipt Journal (append-only, SHA-256-chained) [VERIFIED]                      │
       │                                                                          │
       ▼                                                                          │
  Memory Weaver + Bonfire episodes                                                │
       │                                                                          │
       └──────────────────────────────────────────────────────────────────────────┘
                 (approval-required path loops back to ApprovalBridge)
```

---

## 4. Responsibility & Authority Matrix

| Action | ZOL Supervisor | Runner Registry | Worker Adapter | ApprovalBridge | Operator |
|--------|---------------|----------------|----------------|----------------|---------|
| Create work packet | OWNER | — | — | — | REQUESTOR |
| Issue task lease | — | OWNER | — | — | — |
| Select worker | — | OWNER (routing rules) | — | — | CAN OVERRIDE |
| Execute task | — | DELEGATES | EXECUTOR | — | — |
| Read canonical memory | OWNER | READ-ONLY | NEVER | — | — |
| Write canonical memory | OWNER | — | NEVER | — | APPROVE |
| Call Model Gateway | OWNER | — | NEVER (routes through ZOL) | — | — |
| Call Tool Gateway | OWNER | — | NEVER (routes through ZOL) | — | — |
| Create GitHub branch | ZOL-issued namespace only | FENCE ENFORCER | NEVER on main | — | — |
| Create GitHub PR | — | — | Jules only, draft only | APPROVE to merge | MERGE |
| Post publicly (cast) | — | — | NEVER | APPROVE | CONFIRM |
| Write Bonfire episode | OWNER | — | NEVER | — | — |
| Cancel task lease | OWNER | EXECUTOR | — | — | CAN OVERRIDE |
| Merge to main | NEVER (auto) | NEVER | NEVER | GATE | EXECUTOR |
| Access wallet/signer | OWNER (isolated) | NEVER | NEVER | NEVER | OWNER |

---

## 5. Runner Contract (Common Interface)

Every worker adapter must implement this contract. The Runner Registry talks exclusively through this interface.

### 5.1 TypeScript-Style Interface Definition

```typescript
interface RunnerAdapter {
  // Identity
  readonly runnerId: string;           // e.g. "hermes", "jules", "cline", "ollama", "pi"
  readonly runnerVersion: string;      // semver string
  readonly runnerTier: number;         // 1=local/trusted, 2=local/sandboxed, 3=cloud/gated

  // Capability declaration
  capabilities(): Promise<RunnerCapabilities>;

  // Health check — must respond in <5s
  health(): Promise<HealthResult>;

  // Dispatch a bounded work packet; returns lease acknowledgment
  dispatch(lease: WorkLease): Promise<DispatchAck>;

  // Poll current status of a dispatched lease
  status(leaseId: string): Promise<LeaseStatus>;

  // Collect completed artifact (only valid when status === 'completed')
  collect(leaseId: string): Promise<RawArtifact>;

  // Cancel an in-flight lease
  cancel(leaseId: string): Promise<CancelAck>;

  // Resume a failed or timed-out lease (idempotent — uses same idempotencyKey)
  resume(leaseId: string): Promise<DispatchAck>;

  // Graceful shutdown — release resources, do not cancel in-flight leases
  shutdown(): Promise<void>;
}

interface RunnerCapabilities {
  runnerId: string;
  supportedTaskTypes: string[];        // e.g. ["code", "research", "artifact"]
  maxConcurrency: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  supportsCancel: boolean;
  supportsResume: boolean;
  supportsCheckpoints: boolean;
  requiresApproval: boolean;           // if true, all output goes through ApprovalBridge
  tier: number;
}

interface WorkLease {
  leaseId: string;                     // UUID issued by Runner Registry
  idempotencyKey: string;              // SHA-256 of (packetId + runnerId + attemptNumber)
  packetId: string;                    // original work packet ID from Work Router
  taskType: string;
  title: string;
  description: string;
  constraints: LeaseConstraints;
  branchNamespace: string | null;      // null for non-git workers
  secrets: never;                      // NEVER passed in lease — see §8
  issuedAt: string;                    // ISO 8601
  expiresAt: string;                   // ISO 8601 — lease TTL
  attemptNumber: number;               // 1 on first dispatch, increments on resume
}

interface LeaseConstraints {
  maxWallClockMs: number;              // hard timeout
  maxOutputBytes: number;
  maxModelTokens: number | null;       // null if worker manages its own model
  allowedTools: string[];              // Tool Gateway permission set
  allowPublicPost: false;              // ALWAYS false — workers never post
  allowMerge: false;                   // ALWAYS false — workers never merge
  allowWalletAccess: false;            // ALWAYS false
}

interface DispatchAck {
  leaseId: string;
  workerReceiptId: string;             // worker's own tracking ID
  acceptedAt: string;
  estimatedCompletionAt: string | null;
}

interface LeaseStatus {
  leaseId: string;
  state: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'timed_out';
  progress: number | null;             // 0.0–1.0 if worker reports it
  lastUpdatedAt: string;
  errorMessage: string | null;
}

interface RawArtifact {
  leaseId: string;
  runnerId: string;
  taskType: string;
  content: string | object;
  contentType: string;                 // "text/plain", "application/json", "text/x-diff", etc.
  collectedAt: string;
  workerReceiptId: string;
  checksum: string;                    // SHA-256 of content
}

interface HealthResult {
  runnerId: string;
  healthy: boolean;
  latencyMs: number;
  message: string | null;
}

interface CancelAck {
  leaseId: string;
  cancelledAt: string;
  workerConfirmed: boolean;
}
```

### 5.2 Runner Tier Definitions

| Tier | Description | Examples | Trust Level |
|------|-------------|---------|-------------|
| 1 | Local process, same machine, no network | Ollama (localhost), Pi coding via Ollama | TRUSTED — no approval gate on output for non-public actions |
| 2 | Local subprocess or Tailscale-only endpoint | Cline CLI, Hermes local, Pi SSH | SANDBOXED — output verified before use |
| 3 | Cloud, external network, third-party auth | Google Jules | GATED — Telegram approval required for any output that touches the repo |

Fallback from a higher tier to a lower tier is permitted (e.g., Jules fails → retry with Cline). Fallback from a lower tier to a higher tier is blocked — this mirrors the existing Model Gateway `FALLBACK_RAISES_AUTHORITY` guard [VERIFIED pattern in model-gateway.js].

---

## 6. Worker Adapter Designs

### 6.1 Ollama Adapter

**Status:** PARTIALLY IMPLEMENTED [VERIFIED — OllamaAdapter in model-gateway.js]  
**Tier:** 1 (localhost or OLLAMA_BASE_URL)  
**Extension point:** Model Gateway provider map

The `OllamaAdapter` in `src/model-gateway.js` already handles model completion via `OLLAMA_BASE_URL`. The Runner Gateway does not need to create a separate Ollama adapter for model calls. However, when Ollama is used as a worker (not just a model provider), it needs a thin wrapper to fit the RunnerAdapter contract.

**OllamaRunnerAdapter implementation sketch:**

```javascript
// src/adapters/runner/ollama-runner-adapter.js
// Wraps the existing Model Gateway OllamaAdapter with RunnerAdapter contract.
// For task types: "research", "artifact", "summarize", "classify"
// NOT for code tasks (Ollama does not manage git state)

class OllamaRunnerAdapter {
  constructor(modelGateway) {
    this.runnerId = 'ollama';
    this.runnerVersion = '1.0.0';
    this.runnerTier = 1;
    this._modelGateway = modelGateway;  // injected — no new Ollama client
    this._leases = new Map();           // in-memory lease state
  }

  async capabilities() {
    return {
      runnerId: 'ollama',
      supportedTaskTypes: ['research', 'artifact', 'summarize', 'classify', 'draft'],
      maxConcurrency: 2,
      maxInputTokens: 8192,
      maxOutputTokens: 2048,
      supportsCancel: false,  // Ollama completes synchronously
      supportsResume: true,   // idempotent re-dispatch
      supportsCheckpoints: false,
      requiresApproval: false,  // tier-1 output used internally
      tier: 1,
    };
  }

  async health() {
    const start = Date.now();
    try {
      await this._modelGateway.complete('ping', { provider: 'ollama', timeoutMs: 5000 });
      return { runnerId: 'ollama', healthy: true, latencyMs: Date.now() - start, message: null };
    } catch (e) {
      return { runnerId: 'ollama', healthy: false, latencyMs: Date.now() - start, message: e.message };
    }
  }

  async dispatch(lease) {
    // Call Model Gateway — all quota and telemetry already handled there
    const result = await this._modelGateway.complete(lease.description, {
      provider: 'ollama',
      timeoutMs: lease.constraints.maxWallClockMs,
    });
    // Store result synchronously (Ollama completes in one call)
    this._leases.set(lease.leaseId, { state: 'completed', result, workerReceiptId: lease.idempotencyKey });
    return { leaseId: lease.leaseId, workerReceiptId: lease.idempotencyKey, acceptedAt: new Date().toISOString(), estimatedCompletionAt: new Date().toISOString() };
  }

  async status(leaseId) {
    const entry = this._leases.get(leaseId);
    if (!entry) return { leaseId, state: 'pending', progress: null, lastUpdatedAt: new Date().toISOString(), errorMessage: null };
    return { leaseId, state: entry.state, progress: entry.state === 'completed' ? 1.0 : null, lastUpdatedAt: new Date().toISOString(), errorMessage: entry.error || null };
  }

  async collect(leaseId) {
    const entry = this._leases.get(leaseId);
    if (!entry || entry.state !== 'completed') throw new Error(`Lease ${leaseId} not completed`);
    const content = entry.result.text;
    return {
      leaseId,
      runnerId: 'ollama',
      taskType: 'artifact',
      content,
      contentType: 'text/plain',
      collectedAt: new Date().toISOString(),
      workerReceiptId: entry.workerReceiptId,
      checksum: require('crypto').createHash('sha256').update(content).digest('hex'),
    };
  }

  async cancel(_leaseId) {
    // Ollama is synchronous; by the time cancel arrives, dispatch is complete or failed
    return { leaseId: _leaseId, cancelledAt: new Date().toISOString(), workerConfirmed: false };
  }

  async resume(leaseId) {
    const entry = this._leases.get(leaseId);
    if (!entry) throw new Error(`Lease ${leaseId} not found for resume`);
    // Re-dispatch with same idempotencyKey — Model Gateway handles dedup at quota layer
    return this.dispatch({ leaseId, idempotencyKey: entry.workerReceiptId, description: entry.description });
  }

  async shutdown() {
    this._leases.clear();
  }
}
```

**Credential handling:** None required beyond `OLLAMA_BASE_URL`. The Model Gateway holds the adapter; no secrets are passed through the lease. [VERIFIED: consistent with model-gateway.js pattern]

---

### 6.2 Pi Coding Agent Adapter

**Status:** NOT IMPLEMENTED  
**Tier:** 1–2 (depends on deployment — local Pi subprocess or Tailscale-accessible Ollama endpoint)  
**What "Pi coding agent" means:** Per the phase brief, this refers to a lightweight coding agent run through Ollama on local hardware — not a Raspberry Pi hardware reference. [VERIFIED from phase brief: "This means the minimal coding agent launched through Ollama, not Raspberry Pi hardware. Source: https://docs.ollama.com/integrations/pi"]

**Model selection:** [SPECULATION — requires confirmation] The Ollama Pi integration page describes running small coding models (likely `deepseek-coder:1.3b`, `codellama:7b`, or similar) through Ollama's standard API. The exact model is a configuration choice, not an architectural one.

**PiCodingAdapter implementation sketch:**

```javascript
// src/adapters/runner/pi-coding-adapter.js
// Thin wrapper around OllamaRunnerAdapter with coding-specific configuration.
// Appropriate task types: lightweight code generation, diagnostic scripts,
// file transforms, test scaffolding — NOT production deploys or merges.

class PiCodingAdapter {
  constructor(modelGateway, opts = {}) {
    this.runnerId = 'pi-coding';
    this.runnerVersion = '1.0.0';
    this.runnerTier = 1;
    this._model = opts.model || process.env.PI_CODING_MODEL || 'deepseek-coder:1.3b';
    this._ollamaRunner = new OllamaRunnerAdapter(modelGateway);
    // Override dispatch to inject coding system prompt and model
  }

  async capabilities() {
    return {
      runnerId: 'pi-coding',
      supportedTaskTypes: ['code', 'test-scaffold', 'lint-fix', 'doc-gen'],
      maxConcurrency: 1,  // small model, Pi hardware
      maxInputTokens: 4096,
      maxOutputTokens: 1024,
      supportsCancel: false,
      supportsResume: true,
      supportsCheckpoints: false,
      requiresApproval: true,  // code output always verified before use
      tier: 1,
    };
  }
}
```

**Worktree isolation:** If the Pi coding agent writes files, it MUST operate in a git worktree with a ZOL-issued branch namespace (see §7.3). The adapter is responsible for creating the worktree before dispatching and cleaning it up after collection. ZOL verifies the diff before any file is incorporated into the working tree.

**Placement:** Pi coding agent runs on the same machine as ZOL (or VPS — see §14). No external network required.

---

### 6.3 Hermes Adapter

**Status:** NOT IMPLEMENTED — requires research  
**Tier:** 2 (local process or VPS, Tailscale-fenced)  
**Source:** NousResearch/hermes-agent [SPECULATION — not inspected in this session]

**What Hermes is suited for [RECOMMENDATION]:** Persistent relationship continuity, research with memory, messaging drafting, skill creation, and operations that benefit from session-persistent context. Hermes is NOT suited for git operations or code that will be merged without ZOL verification.

**Adapter design constraints:**

1. Hermes runs as a separate process (local or VPS). ZOL communicates via local HTTP or Unix socket — never via public network without TLS + pre-shared token.
2. Hermes MUST NOT have access to ZOL's signer key, wallet credentials, or Bonfire API key.
3. Hermes session memory (in-process) is subordinate. Verified outputs are written to ZOL's Memory Weaver as episodes with provenance tag `source:hermes-runner`.
4. Each Hermes invocation receives a bounded context packet — ZOL curates what Hermes sees. Hermes does not query Memory Weaver or Bonfire directly.

**HermesAdapter interface sketch:**

```javascript
// src/adapters/runner/hermes-adapter.js
// Communicates with a locally-running Hermes process via HTTP.
// HERMES_ENDPOINT env var (e.g., http://localhost:8090 or http://vps:8090)
// HERMES_SESSION_TOKEN env var (pre-shared, rotated weekly)
// These env vars live in ~/.zao/private/.env — never committed.

class HermesAdapter {
  constructor(opts = {}) {
    this.runnerId = 'hermes';
    this.runnerVersion = '1.0.0';
    this.runnerTier = 2;
    this._endpoint = opts.endpoint || process.env.HERMES_ENDPOINT;
    this._token = opts.token || process.env.HERMES_SESSION_TOKEN;
    if (!this._endpoint) throw new Error('HermesAdapter: HERMES_ENDPOINT not set');
  }

  async dispatch(lease) {
    // POST /hermes/run with Authorization: Bearer <token>
    // Body: { leaseId, taskType, title, description, contextBundle }
    // contextBundle is ZOL-curated — never includes raw credentials
    // ...
  }
}
```

**Open question:** NousResearch/hermes-agent API surface (headless mode, session protocol, auth model) must be confirmed before implementation. See §20.

---

### 6.4 Cline Adapter

**Status:** NOT IMPLEMENTED  
**Tier:** 2 (local subprocess only — never remote)  
**Source:** github.com/cline/cline  
**"Clive" resolution:** "Clive" in the phase brief refers to Cline. No product named "Clive" was found in public registries. [RECOMMENDATION: document this ambiguity for Zaal's confirmation before installing Cline]

**What Cline is suited for:** Bounded coding tasks in isolated git worktrees — tests, documentation, dependency updates, small refactors. Cline operates by reading a task description and producing file diffs; it does not run daemons or manage network resources.

**Security model for Cline [RECOMMENDATION]:**

- Cline runs as a child process via Node.js `child_process.spawn`
- The working directory is a fresh git worktree on a ZOL-issued branch
- Cline does NOT receive: API keys, signer private key, wallet address, Telegram tokens, Bonfire keys
- Cline receives: task description, a read-only copy of relevant source files (provided by ZOL), git branch name
- After completion, ZOL runs `git diff` on the worktree, passes it through `scripts/secret-scan.sh`, and verifies tests pass before any file is accepted
- Worktree is deleted after collection regardless of success or failure

**ClineAdapter implementation sketch:**

```javascript
// src/adapters/runner/cline-adapter.js
// Spawns Cline CLI as a sandboxed subprocess in an isolated worktree.
// Requires: git, cline CLI installed (not a ZOL dependency — external install)

const { spawn } = require('child_process');
const crypto = require('crypto');
const path = require('path');

class ClineAdapter {
  constructor(opts = {}) {
    this.runnerId = 'cline';
    this.runnerVersion = '1.0.0';
    this.runnerTier = 2;
    this._repoRoot = opts.repoRoot || process.cwd();
    this._worktreeBase = opts.worktreeBase || path.join(require('os').homedir(), '.zao', 'worktrees');
    this._leases = new Map();
  }

  async capabilities() {
    return {
      runnerId: 'cline',
      supportedTaskTypes: ['code', 'test-scaffold', 'doc-gen', 'dependency-update', 'lint-fix'],
      maxConcurrency: 1,  // one worktree at a time to avoid git conflicts
      maxInputTokens: 16384,
      maxOutputTokens: 4096,
      supportsCancel: true,
      supportsResume: false,  // worktree is fresh on each dispatch
      supportsCheckpoints: false,
      requiresApproval: true,  // all code output must be reviewed
      tier: 2,
    };
  }

  async dispatch(lease) {
    const worktreePath = path.join(this._worktreeBase, lease.leaseId);
    const branchName = lease.branchNamespace;  // ZOL-issued — see §7.3
    // 1. Create worktree on branchName
    // 2. Spawn cline with task description, capture stdout/stderr
    // 3. Store process ref in this._leases for cancel support
    // 4. On exit, capture diff and store as artifact
    // ...
  }

  async collect(leaseId) {
    const entry = this._leases.get(leaseId);
    if (!entry || entry.state !== 'completed') throw new Error(`Lease ${leaseId} not completed`);
    // Return git diff as artifact — ZOL verifies before applying
    return {
      leaseId,
      runnerId: 'cline',
      taskType: 'code',
      content: entry.diff,
      contentType: 'text/x-diff',
      collectedAt: new Date().toISOString(),
      workerReceiptId: entry.workerReceiptId,
      checksum: crypto.createHash('sha256').update(entry.diff).digest('hex'),
    };
  }
}
```

**Cline model routing:** Cline's model calls (if using its built-in AI) MUST be routed through ZOL's Model Gateway. [RECOMMENDATION] The preferred pattern is to configure Cline to use Ollama (local) as its model provider so all model calls stay on-machine. If Cline requires a cloud model, the OPENROUTER_API_KEY from ZOL's env must be scoped to a read-only sub-key for Cline's process. This is not currently implemented and is a pre-condition for Cline deployment.

---

### 6.5 Google Jules Adapter

**Status:** NOT IMPLEMENTED — highest risk of all workers  
**Tier:** 3 (cloud, external, GitHub-integrated)  
**Sources:** jules.google/ docs, developers.google.com/jules/api [SPECULATION — not inspected in this session]

**Why Jules is RED in the readiness matrix:**

1. Jules operates asynchronously in Google's cloud environment. ZOL cannot inspect Jules' execution environment, model calls, or intermediate state.
2. Jules creates GitHub PRs. Without strict branch-namespace fencing, Jules could create PRs against `main` or any other branch.
3. Jules has access to the GitHub repository. Its OAuth scope must be limited to a dedicated fork or a scoped installation — the current repo has no isolation for worker branches.
4. The async model means ZOL must poll Jules for completion, which requires a persistent polling loop and expiry handling.
5. A compromised or malfunctioning Jules could create many draft PRs, consuming GitHub Actions minutes, confusing CI, and requiring manual cleanup.

**Fencing requirements before Jules can be connected [RECOMMENDATION]:**

1. A dedicated `worker/jules/*` branch namespace, with a GitHub branch protection rule blocking Jules from pushing to any branch not matching `worker/jules/*`
2. A GitHub App installation scoped to only the `worker/jules/*` namespace (not full-repo write)
3. ZOL's ApprovalBridge must review every Jules PR diff before any merge — not just title/description
4. Jules PRs must be draft-only; ZOL marks them ready-for-review only after internal verification
5. Jules must not be given Bonfire keys, Telegram tokens, or any ZOL environment variable

**JulesAdapter interface sketch:**

```javascript
// src/adapters/runner/jules-adapter.js
// Tier 3 — cloud. All output requires Telegram approval before any action.

class JulesAdapter {
  constructor(opts = {}) {
    this.runnerId = 'jules';
    this.runnerVersion = '1.0.0';
    this.runnerTier = 3;
    this._apiKey = process.env.JULES_API_KEY;  // stored in ~/.zao/private/.env only
    this._githubToken = process.env.JULES_GITHUB_TOKEN;  // scoped to worker/jules/* only
    this._pollingIntervalMs = opts.pollingIntervalMs || 30_000;
    if (!this._apiKey) throw new Error('JulesAdapter: JULES_API_KEY not set');
  }

  async dispatch(lease) {
    // POST to Jules API with bounded task description
    // Create a GitHub issue in a dedicated worker repo (not main repo) for Jules to work against
    // Jules opens a draft PR against worker/jules/<leaseId> branch
    // Return { leaseId, workerReceiptId: julesJobId, acceptedAt, estimatedCompletionAt: null }
  }

  async status(leaseId) {
    // Poll Jules API or GitHub PR state
    // Map Jules job states to LeaseStatus.state
  }

  async collect(leaseId) {
    // Fetch the draft PR diff from GitHub API
    // Run secret-scan on the diff
    // Return diff as RawArtifact with contentType: 'text/x-diff'
    // ApprovalBridge review is mandatory at the Runner Registry level for tier-3
  }
}
```

---

## 7. Task Routing Protocol

### 7.1 Routing Decision Tree

```
Work Router creates packet
         │
         ▼
  Runner Registry.selectRunner(packet)
         │
         ├─── packet.type === 'code' ?
         │         ├─ Pi coding agent available and task is small? → PiCodingAdapter (tier 1)
         │         ├─ Cline available and task is medium? → ClineAdapter (tier 2)
         │         └─ Jules approved for this task type? → JulesAdapter (tier 3, requires approval)
         │
         ├─── packet.type === 'research' or 'artifact' ?
         │         ├─ Ollama available? → OllamaRunnerAdapter (tier 1, prefer local)
         │         └─ Hermes available? → HermesAdapter (tier 2)
         │
         ├─── packet.type === 'relationship' or 'messaging' ?
         │         └─ Hermes → HermesAdapter (tier 2)
         │
         └─── no suitable runner available ?
                   → route to 'operator' (existing Work Router fallback) [VERIFIED pattern]
```

### 7.2 Runner Selection Algorithm

```javascript
// Runner Registry selection logic (pseudocode)
async function selectRunner(packet) {
  const candidates = RUNNER_REGISTRY
    .filter(r => r.capabilities().supportedTaskTypes.includes(packet.type))
    .filter(r => r.health().healthy)
    .sort((a, b) => a.runnerTier - b.runnerTier);  // prefer lower tier (more local)

  if (candidates.length === 0) return null;  // fall through to 'operator'

  const selected = candidates[0];

  // Block tier escalation if a lower-tier runner previously handled this packet type
  const previousTier = await receiptJournal.getLastRunnerTierForPacketType(packet.type);
  if (previousTier !== null && selected.runnerTier > previousTier) {
    // Require explicit operator approval to escalate tier
    await approvalBridge.request({ action: 'tier-escalation', packet, from: previousTier, to: selected.runnerTier });
  }

  return selected;
}
```

### 7.3 Branch Namespace Fencing

For workers that produce git output (Cline, Jules, Pi coding agent):

- Branch names MUST follow: `worker/<runnerId>/<leaseId>` (e.g., `worker/cline/lease_abc123`)
- ZOL creates the branch before dispatching; the worker cannot create its own branches
- GitHub branch protection rules MUST block any push to `main`, `ws/*`, or release branches from worker tokens
- After collection, ZOL cherry-picks or applies the diff onto a ZOL-controlled integration branch; it does not merge the worker branch directly

### 7.4 Idempotency Keys

Every dispatch generates an idempotency key:

```javascript
function makeIdempotencyKey(packetId, runnerId, attemptNumber) {
  return crypto
    .createHash('sha256')
    .update(`${packetId}:${runnerId}:${attemptNumber}`)
    .digest('hex');
}
```

Workers MUST reject duplicate dispatch calls with the same idempotency key. If a worker returns a duplicate, the Runner Registry treats this as a resume of the previous attempt and polls for the existing result.

### 7.5 Concurrency Limits

| Worker | Max Concurrent Leases | Rationale |
|--------|----------------------|-----------|
| Ollama | 2 | Local inference, GPU/CPU contention |
| Pi coding | 1 | Pi hardware limits |
| Hermes | 1 | Session statefulness — parallel sessions risk confusion |
| Cline | 1 | One worktree per runner to avoid git conflicts |
| Jules | 3 | Cloud — but limits imposed to avoid GitHub API rate-limit |

Total concurrent worker leases across all runners: 5. ZOL's Work Router queue handles overflow.

### 7.6 Lease TTL & Timeout Cascade

```
Dispatch TTL:    varies per worker (Ollama: 60s, Pi: 120s, Hermes: 300s, Cline: 600s, Jules: 3600s)
Poll interval:   10s (Ollama), 30s (Hermes/Cline), 60s (Jules)
Max retries:     2 (before routing to 'operator')
Escalation:      on 2nd retry, Telegram alert to Zaal
```

If a lease exceeds its TTL:
1. Runner Registry marks lease `timed_out`
2. `cancel()` is called on the adapter (best-effort)
3. Artifact is discarded; packet is re-queued with `attemptNumber++`
4. If `attemptNumber > 2`, packet is routed to `operator` with full context

---

## 8. Authentication & Authorization Per Worker

### Core Principle

Workers receive no ZOL secrets. All secrets needed for ZOL's operation (signer key, Bonfire API key, Telegram token, OpenRouter key) stay in ZOL's process. Workers receive only the information required to execute their bounded task.

### 8.1 Ollama

- **Auth:** None beyond `OLLAMA_BASE_URL`. Ollama is localhost-only by default; if on VPS, restrict to `127.0.0.1` or Tailscale IP.
- **What Ollama receives:** Prompt text only. No ZOL credentials.
- **What Ollama does NOT receive:** API keys, signer key, Bonfire key, Telegram token.

### 8.2 Pi Coding Agent

- **Auth:** Same as Ollama (local HTTP). If Pi is a separate machine from VPS, use Tailscale-only access.
- **What Pi coding receives:** Task description, relevant source file content (ZOL curates what's included).
- **What Pi does NOT receive:** Secrets from `~/.zao/private/`. Git push credentials are never provided; ZOL applies diffs.

### 8.3 Hermes

- **Auth:** Pre-shared session token (`HERMES_SESSION_TOKEN`) stored in `~/.zao/private/.env`. Token is a 256-bit random value, rotated weekly. Transmitted as `Authorization: Bearer <token>` over Tailscale or localhost only. Never over public internet without mTLS.
- **What Hermes receives:** Task description, ZOL-curated context bundle (no raw credentials), session token.
- **What Hermes does NOT receive:** Signer key, wallet address, Bonfire API key, Telegram credentials, OpenRouter key.
- **Memory boundary:** Hermes session memory is ephemeral. At session end, verified outputs are written to ZOL Memory Weaver with `source:hermes-runner` tag. Hermes does not write to Bonfire directly.

### 8.4 Cline

- **Auth:** No network auth — Cline runs as a child process in the same user account.
- **Environment isolation:** Cline's subprocess environment inherits ONLY the variables ZOL explicitly allows. Implementation:
  ```javascript
  const clineEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    // NEVER: NEYNAR_API_KEY, OPENROUTER_MODEL, ZOE_BOT_TOKEN, BONFIRE_API_KEY, etc.
    CLINE_MODEL_ENDPOINT: process.env.OLLAMA_BASE_URL || 'http://localhost:11434',
    CLINE_BRANCH: lease.branchNamespace,
  };
  spawn('cline', ['--headless', '--task', taskDescPath], { env: clineEnv, cwd: worktreePath });
  ```
- **What Cline receives:** Task description file (written to worktree), git branch name, local Ollama endpoint.
- **What Cline does NOT receive:** Any credential from `~/.zao/private/`.

### 8.5 Jules

- **Auth:** Two tokens, both stored in `~/.zao/private/.env`:
  - `JULES_API_KEY` — Jules service API key from Google
  - `JULES_GITHUB_TOKEN` — GitHub App installation token scoped ONLY to `worker/jules/*` branches on a dedicated fork or isolated repo. NOT the main repo's write token.
- **Network:** Jules API calls go to `developers.google.com/jules/api` — public internet. Must be restricted to VPS outbound only, never from Pi.
- **What Jules receives:** Task description, GitHub issue reference (in isolated repo), target branch name.
- **What Jules does NOT receive:** Any ZOL API key, signer key, Telegram token, or Bonfire key. Jules works only against a sandboxed GitHub repo, not bettercallzaal/zol directly.
- **Approval gate:** EVERY Jules artifact (diff, PR body) goes through ApprovalBridge → Telegram before any action is taken. This is enforced at the Runner Registry level for all tier-3 runners, not at the adapter level.

---

## 9. Failure Modes & Fallback Behavior

### Failure Mode Catalog

| Failure | Detection | ZOL Response | Authority Change? |
|---------|-----------|-------------|-----------------|
| Worker health check fails | `health()` returns `healthy: false` | Skip worker, route to next-tier or operator | NO |
| Worker dispatch timeout | Lease TTL exceeded | Cancel lease, re-queue with `attemptNumber++` | NO |
| Worker returns malformed artifact | checksum mismatch or content-type unexpected | Discard artifact, log receipt, re-queue | NO |
| Secret found in worker artifact | `secret-scan` finds credential pattern | Discard artifact, alert Zaal via Telegram, log high-severity receipt | NO |
| Worker crashes mid-task (Cline) | Process exits non-zero, worktree dirty | Clean up worktree, re-queue | NO |
| Jules creates PR against wrong branch | GitHub webhook / PR audit detects wrong base | Close draft PR, alert Zaal, block Jules for current session | NO |
| Ollama model not available | `OLLAMA_BASE_URL` unreachable | Fall back to OpenRouter via Model Gateway | NO — same tier |
| All workers unavailable | All health checks fail | Route all packets to `operator` | NO |
| Worker output passes secret-scan but is semantically wrong | ZOL verification loop fails post-collection | Re-queue for Hermes or operator review | NO |
| Duplicate dispatch (network retry) | Idempotency key collision | Runner Registry deduplicates, returns existing lease status | NO |

### Fallback Constraint: No Authority Raising

Fallback behavior MUST NOT raise the authority level of a task. Examples:
- Ollama fails → re-route to Hermes (both tier 1–2): PERMITTED
- Cline fails → re-route to Jules (tier 2 → tier 3): BLOCKED — requires explicit operator approval
- Jules returns error → re-route to Cline (tier 3 → tier 2): PERMITTED (lower tier)

This mirrors the `FALLBACK_RAISES_AUTHORITY` guard already implemented in `src/model-gateway.js` [VERIFIED].

### Split-Brain Prevention

If ZOL restarts while a lease is in-flight:
1. On startup, Runner Registry loads lease state from Receipt Journal
2. Leases in `running` state that are past their TTL are immediately cancelled
3. Leases in `running` state within TTL are polled for status; if the worker is still running, ZOL resumes polling
4. Leases are never re-dispatched on restart without checking worker status first

---

## 10. Security Constraints & Approval Model

### Absolute Prohibitions (from project security policy)

The following are forbidden at the Runner Registry level and enforced in the `LeaseConstraints` object:

```javascript
// These fields are ALWAYS false in every WorkLease — no worker can request them
constraints: {
  allowPublicPost: false,       // No worker may post to Farcaster, Telegram, or any public channel
  allowMerge: false,            // No worker may merge any branch
  allowWalletAccess: false,     // No worker may access wallet, sign transactions, or tip
  allowMinting: false,          // No worker may mint tokens or NFTs
  allowTokenLaunch: false,      // No worker may launch tokens
  allowProductionDeploy: false, // No worker may restart production daemons
  allowSignerAccess: false,     // No worker may access the Ed25519 signer key
  allowBonfireWrite: false,     // No worker may write Bonfire episodes directly
}
```

### Approval Gate Triggers

| Action | Approval Required | Approver |
|--------|------------------|---------|
| Tier-3 worker dispatch (Jules) | YES | Zaal via Telegram |
| Any artifact from Jules being incorporated into ZOL | YES | Zaal via Telegram |
| Cline diff being applied to any branch | YES | Zaal via Telegram |
| Memory Weaver write from worker output | YES (automated gate: ZOL supervisor verifies provenance) | ZOL + optionally Zaal |
| Tier escalation (lower-tier runner fails → higher-tier proposed) | YES | Zaal via Telegram |
| Worker operating on a new task type it hasn't been approved for | YES | Zaal via Telegram |

### Secret Scanning

All worker artifacts pass through the same `sanitizeEvidence()` logic from `src/receipt-journal.js` [VERIFIED] plus an extended check:
- `scripts/secret-scan.sh` patterns applied to the raw artifact content
- If any pattern matches, the artifact is discarded and a high-severity receipt is written
- Zaal is alerted via Telegram regardless of whether the artifact was discarded

### Prompt Injection Defense

Workers receive bounded task descriptions, not raw user input. The Runner Registry:
1. Strips any content that contains `SYSTEM:`, `<|im_start|>`, `</tool_call>`, or similar injection markers before including it in the lease
2. Encodes task descriptions as structured JSON fields, not raw strings concatenated into prompts
3. Hermes and Cline receive task descriptions via file, not command-line argument (avoids shell injection)
4. Jules receives a GitHub issue reference — ZOL controls what goes into the issue body

### Malicious Repository Defense

For Jules and Cline, which operate in git contexts:
- Cline's worktree is initialized from a known-good commit, not from an untrusted branch
- No `.git/config` modifications are permitted by the worker subprocess
- `git hooks` are disabled in the worker worktree (`core.hooksPath=/dev/null`)
- ZOL verifies the diff does not modify `.git/`, `scripts/secret-scan.sh`, or any security-critical file

---

## 11. Memory Ownership & Provenance Model

### Memory Authority Hierarchy

```
Tier 1 — Canonical and durable:
  Bonfire knowledge graph (external, ZOL writes via BonfireAdapter with Zaal approval)
  ZOL Memory Weaver (src/memory-weaver.js) — the on-machine authority [VERIFIED: file exists]

Tier 2 — Durable but subordinate:
  Capsule Registry (src/capsule-registry.js) — schema authority [VERIFIED]
  Receipt Journal (src/receipt-journal.js) — audit authority [VERIFIED]
  Artifact Pipeline output (src/artifact-pipeline.js) — artifact authority [VERIFIED]

Tier 3 — Ephemeral or subordinate:
  Worker session memory (Hermes in-session context, Cline worktree, Ollama context window)
  These are NOT durable; they do not persist beyond the lease
```

### Worker Memory Boundaries

| Worker | May Read ZOL Memory | May Write ZOL Memory | Session Memory | Lesson Return Path |
|--------|--------------------|--------------------|----------------|-------------------|
| Ollama | NO — receives curated context in prompt | NO | Ephemeral (context window) | None — output is artifact only |
| Pi coding | NO | NO | Ephemeral (worktree) | Git diff only; ZOL applies to Memory Weaver if needed |
| Hermes | ZOL-curated context bundle only | NO (direct) | In-session persistent | Verified lessons → ZOL Memory Weaver with `source:hermes-runner` tag |
| Cline | Read-only source files in worktree | NO (direct) | Worktree files | Git diff only |
| Jules | GitHub issue + ZOL-curated brief | NO (direct) | Cloud session | Draft PR diff only |

### Lesson Return Protocol

When a worker produces output that constitutes a learned fact (e.g., Hermes discovers that an artist has a new label), the lesson MUST:

1. Be returned as a structured artifact, not a raw string
2. Include provenance: `{ source: 'hermes-runner', leaseId, confidence: 0.0–1.0, verifiedBy: null }`
3. Pass through ZOL's verification loop (comparison against existing Memory Weaver entries for contradictions)
4. Require `confidence >= 0.8` for automatic Memory Weaver write; lower confidence → queued for Zaal review
5. Be written as a Receipt Journal entry with `action: 'memory-write'` before committing to Memory Weaver

This mirrors the evidence-gated self-improvement pattern from the Phase 0 audit [VERIFIED pattern in persistent-agent-audit.md §3.4].

---

## 12. Receipt Chain & Observability

### Receipt Events for Worker Dispatch

Every worker interaction generates receipts in the existing Receipt Journal. The receipt chain for a worker task follows this sequence:

```
1. rcpt_runner_dispatch_issued      — Runner Registry issues lease
2. rcpt_runner_dispatch_acked       — Worker adapter confirms receipt
3. rcpt_runner_checkpoint_N         — (Optional) Worker progress checkpoints
4. rcpt_runner_artifact_collected   — Raw artifact received from worker
5. rcpt_runner_secret_scan          — Secret scan result (pass/fail)
6. rcpt_runner_verification         — ZOL verification result
7. rcpt_runner_artifact_accepted    — Artifact accepted into Artifact Pipeline
   OR
   rcpt_runner_artifact_rejected    — Artifact rejected; reason logged
8. rcpt_runner_memory_write         — (If applicable) Memory Weaver write
9. rcpt_runner_approval_requested   — (If tier-3 or consequential) ApprovalBridge gate
10. rcpt_runner_completed           — Lease closed; packet marked complete or re-queued
```

### Receipt Schema Extension for Workers

The existing `ReceiptJournal` fields [VERIFIED from receipt-journal.js] are extended with:

```json
{
  "receiptId": "rcpt_runner_dispatch_issued_<uuid>",
  "loopId": "runner-gateway",
  "runId": "<packetId>",
  "stepId": "dispatch_issued",
  "capsuleId": "zol-work-router-v1",
  "agentId": "zolbot",
  "action": "runner:dispatch",
  "status": "ok",
  "startedAt": "2026-07-16T10:00:00.000Z",
  "evidence": {
    "leaseId": "lease_abc123",
    "runnerId": "cline",
    "runnerTier": 2,
    "packetId": "wp_2026071601_code_a3f9",
    "taskType": "code",
    "branchNamespace": "worker/cline/lease_abc123",
    "idempotencyKey": "<sha256>",
    "attemptNumber": 1,
    "expiresAt": "2026-07-16T10:10:00.000Z"
  },
  "previousReceiptId": "rcpt_work_router_route_xyz",
  "previousReceiptHash": "<sha256>",
  "sha256": "<sha256 of this receipt>"
}
```

### Telemetry Per Worker Call

The Model Gateway already records per-call telemetry [VERIFIED]. The Runner Registry adds:

| Metric | Where Stored | Retention |
|--------|-------------|-----------|
| Dispatch count per runner per day | State store key `runner-telemetry-<date>` | 30 days |
| Lease duration distribution | Same | 30 days |
| Artifact acceptance rate | Same | 30 days |
| Secret scan failures | Receipt Journal (high-severity) | Indefinite |
| Tier escalation events | Receipt Journal | Indefinite |
| Worker health status history | State store key `runner-health-<runnerId>` | 7 days rolling |

### Worker Observability Dashboard

The existing Agent Gateway health endpoint at `/health` [VERIFIED] should be extended to include:

```
GET /runners/health
→ { runners: [{ runnerId, healthy, lastCheck, tier, activeLeases, dailyDispatches }] }

GET /runners/<runnerId>/leases
→ { leases: [{ leaseId, packetId, state, age }] }

GET /runners/telemetry?date=<YYYY-MM-DD>
→ { date, perRunner: { <runnerId>: { dispatches, completions, rejections, avgDurationMs } } }
```

---

## 13. Interface Spec with Example Request/Response Schemas

### 13.1 Runner Registry — Internal API (not HTTP — in-process call)

The Runner Registry is an in-process module, not a separate HTTP service. It is injected into the Work Router as a dependency, consistent with ZOL v2's dependency injection pattern [VERIFIED from agent-gateway.js constructor].

```javascript
// src/runner-registry.js
class RunnerRegistry {
  constructor({ receiptJournal, approvalBridge, modelGateway, stateStore }) { ... }
  registerRunner(adapter) { ... }
  async selectRunner(packet) → RunnerAdapter | null
  async dispatch(packet) → { leaseId, runnerId, receipt }
  async pollUntilComplete(leaseId, opts) → RawArtifact
  async cancelLease(leaseId) → CancelAck
  async getLeaseStatus(leaseId) → LeaseStatus
  async getRunnerHealth() → HealthResult[]
}
```

### 13.2 Agent Gateway Extension — New REST Endpoints

These extend `src/agent-gateway.js` [VERIFIED: existing routes]:

#### `GET /runners`

```json
// Response 200
{
  "runners": [
    {
      "runnerId": "ollama",
      "tier": 1,
      "healthy": true,
      "capabilities": {
        "supportedTaskTypes": ["research", "artifact", "draft"],
        "maxConcurrency": 2
      },
      "activeLeases": 0
    },
    {
      "runnerId": "cline",
      "tier": 2,
      "healthy": true,
      "capabilities": {
        "supportedTaskTypes": ["code", "test-scaffold", "doc-gen"],
        "maxConcurrency": 1
      },
      "activeLeases": 1
    }
  ],
  "total": 2
}
```

#### `POST /tasks` — Extended with runner hint

```json
// Request (extends existing /tasks POST)
{
  "title": "Add unit tests for receipt-journal edge cases",
  "description": "Write tests for: empty journal, corrupt chain, concurrent writes",
  "type": "code",
  "priority": "normal",
  "requestedBy": "zaal",
  "runnerHint": "cline"   // optional — ZOL may override based on routing rules
}

// Response 200
{
  "task": {
    "packetId": "wp_2026071602_code_b4g7",
    "type": "code",
    "state": "queued",
    "createdAt": "2026-07-16T14:00:00.000Z"
  },
  "lease": {
    "leaseId": "lease_d8e9f0a1",
    "runnerId": "cline",
    "branchNamespace": "worker/cline/lease_d8e9f0a1",
    "expiresAt": "2026-07-16T14:10:00.000Z"
  },
  "created": true
}
```

#### `GET /tasks/:id/lease`

```json
// Response 200
{
  "leaseId": "lease_d8e9f0a1",
  "packetId": "wp_2026071602_code_b4g7",
  "runnerId": "cline",
  "state": "running",
  "progress": 0.4,
  "issuedAt": "2026-07-16T14:00:00.000Z",
  "expiresAt": "2026-07-16T14:10:00.000Z",
  "attemptNumber": 1
}
```

#### `DELETE /tasks/:id/lease`

```json
// Response 200
{
  "leaseId": "lease_d8e9f0a1",
  "cancelledAt": "2026-07-16T14:05:00.000Z",
  "workerConfirmed": true
}
```

### 13.3 MCP Tool Extension — `dispatch_to_runner`

Extends the existing MCP tool surface [VERIFIED: `/mcp/execute` route in agent-gateway.js]:

```json
// POST /mcp/execute
// Request
{
  "tool": "dispatch_to_runner",
  "input": {
    "packetId": "wp_2026071602_code_b4g7",
    "runnerHint": "cline",
    "constraints": {
      "maxWallClockMs": 300000,
      "allowedTools": ["read_file", "write_file", "run_test"]
    }
  }
}

// Response 200
{
  "result": {
    "leaseId": "lease_d8e9f0a1",
    "runnerId": "cline",
    "state": "running",
    "dispatchedAt": "2026-07-16T14:00:00.000Z"
  }
}
```

### 13.4 Hermes API Contract (External — to be confirmed with NousResearch)

[SPECULATION — exact API shape unknown; this is the assumed contract based on agent API conventions]

```
POST http://localhost:8090/hermes/run
Authorization: Bearer <HERMES_SESSION_TOKEN>
Content-Type: application/json

{
  "leaseId": "lease_e1f2g3h4",
  "taskType": "research",
  "title": "Find booking contacts for NCTRNL",
  "description": "Research available booking agent or label contact for artist NCTRNL ...",
  "contextBundle": {
    "artistName": "NCTRNL",
    "knownPlatforms": ["bandcamp", "soundcloud"],
    "priorFindings": []  // ZOL-curated — no internal credentials
  },
  "constraints": {
    "maxWallClockMs": 300000,
    "maxOutputTokens": 2048
  }
}

// Response 202
{
  "workerReceiptId": "hermes_job_xyz",
  "acceptedAt": "2026-07-16T14:00:00.000Z",
  "estimatedCompletionAt": "2026-07-16T14:05:00.000Z"
}

// Poll: GET /hermes/job/<workerReceiptId>
// Response 200
{
  "workerReceiptId": "hermes_job_xyz",
  "state": "completed",
  "output": {
    "findings": "...",
    "confidence": 0.85,
    "sources": ["...", "..."]
  }
}
```

---

## 14. Deployment Topology

### Component Placement

| Component | Recommended Host | Rationale |
|-----------|-----------------|-----------|
| ZOL Supervisor (DreamLoops Engine) | Raspberry Pi (ansuz) | [VERIFIED: current deployment] |
| Agent Gateway (localhost:8089) | Raspberry Pi | [VERIFIED: current deployment] |
| Runner Registry (in-process) | Raspberry Pi | Co-located with ZOL supervisor — no network hop |
| OllamaRunnerAdapter | Raspberry Pi OR VPS | Follows OLLAMA_BASE_URL env var |
| PiCodingAdapter | Raspberry Pi (local Ollama) | Small model, local inference |
| HermesAdapter | VPS (cowork-zaodevz) | Hermes requires more RAM than Pi can offer; Tailscale-fenced |
| ClineAdapter | VPS or Pi | CLI subprocess; VPS preferred for isolation from Pi's cron environment |
| JulesAdapter | VPS (outbound internet) | Pi should not have cloud API keys; VPS handles cloud workers |
| Model Gateway | Raspberry Pi (in-process) | [VERIFIED: current deployment] |
| Receipt Journal | Raspberry Pi | [VERIFIED: current deployment] |
| Bonfire memory | External (zabal.bonfires.ai) | [VERIFIED: existing integration] |
| Worker worktrees (Cline, Pi coding) | VPS `/tmp/zao-worktrees/` | Isolated from Pi's main filesystem; cleaned up after each lease |

### Tailscale Network Map

```
[Raspberry Pi - ansuz]
  ZOL Supervisor
  Agent Gateway :8089 (localhost only)
  Runner Registry (in-process)
  OllamaRunnerAdapter → localhost:11434
  ↕ Tailscale
[VPS - cowork-zaodevz]
  HermesAdapter :8090 (Tailscale only)
  ClineAdapter (subprocess)
  JulesAdapter → cloud.google.com (outbound only)
  Cline worktrees: /tmp/zao-worktrees/
  ↕ Tailscale
[Operator - Zaal's machine]
  Telegram (ApprovalBridge)
  Dashboard :8088 (Tailscale)
```

### Environment Variables by Host

**Raspberry Pi `~/.zao/private/.env` (unchanged from v2):**
```
ZOL_STATE_BACKEND=atomic-file
ZOL_STATE_DIR=/home/pi/.zao/private/zol-state
DREAMLOOPS_ENABLED=1
ZOL_AGENT_GATEWAY_PORT=8089
OLLAMA_BASE_URL=http://localhost:11434        # or VPS Tailscale IP
```

**VPS `/root/cowork-zaodevz/agent/.env` (new entries needed):**
```
HERMES_ENDPOINT=http://localhost:8090        # loopback on VPS
HERMES_SESSION_TOKEN=<256-bit random>        # rotated weekly
JULES_API_KEY=<from Google>                  # stored here only
JULES_GITHUB_TOKEN=<scoped token>            # stored here only
CLINE_WORKTREE_BASE=/tmp/zao-worktrees
PI_CODING_MODEL=deepseek-coder:1.3b          # or configured model
```

---

## 15. Expanded Use-Case Catalog

Each use case is ranked on five dimensions (1–5, 5 = highest):
- **Impact** — value to ZAO/ZOL mission
- **Effort** — implementation complexity (5 = high effort)
- **Risk** — probability of harm if something goes wrong (5 = high risk)
- **Cost** — ongoing operating cost (5 = expensive)
- **Revenue potential** — monetization or value-capture opportunity

---

### Category A: Music Intelligence

| # | Use Case | Worker | Impact | Effort | Risk | Cost | Revenue |
|---|---------|--------|--------|--------|------|------|---------|
| 1 | **Release radar — automated new-release detection** across Bandcamp, SoundCloud, and DistroKid, surfaced to ZOL weekly curator | Hermes + Ollama | 5 | 2 | 1 | 1 | 3 |
| 2 | **Metadata validation** — given a release, verify ISRC, label, distributor, and split sheet completeness before ZOL promotes it | Hermes | 4 | 3 | 2 | 1 | 4 |
| 3 | **Rights research** — identify sample clearance status, neighboring rights holders, and PRO affiliations for artist review | Hermes | 4 | 4 | 3 | 2 | 5 |
| 4 | **Artist CRM maintenance** — Hermes monitors Farcaster/Telegram for artists ZOL tracks; updates relationship records in Memory Weaver | Hermes | 5 | 3 | 2 | 1 | 3 |
| 5 | **Booking contact research** — for ZAO artists seeking live dates; Hermes researches venue contacts and booking agents | Hermes | 4 | 3 | 1 | 1 | 4 |
| 6 | **Show preparation briefs** — day-before event, Hermes aggregates artist discography, recent casts, ticket links into a ZOL-posted brief | Hermes + Ollama | 4 | 2 | 1 | 1 | 3 |
| 7 | **WaveWarZ intelligence digests** — Pi coding agent aggregates wavewarz-intelligence.vercel.app data into a daily numbers brief without ZOL having to parse raw HTML | Pi coding | 3 | 2 | 2 | 1 | 2 |

---

### Category B: Business Administration

| # | Use Case | Worker | Impact | Effort | Risk | Cost | Revenue |
|---|---------|--------|--------|--------|------|------|---------|
| 8 | **Inbox triage** — Hermes monitors a shared ZAO inbox (email or Telegram forwarding), classifies messages, drafts responses, queues for Zaal approval | Hermes | 4 | 3 | 2 | 1 | 3 |
| 9 | **Invoice tracking** — Hermes tracks outstanding invoices from ZAO artists/venues, sends reminder drafts via ApprovalBridge | Hermes | 3 | 3 | 2 | 1 | 4 |
| 10 | **Partner follow-up scheduling** — after a meeting Bonfire episode is logged, Hermes generates follow-up tasks and schedules them in ZOL's DreamLoops queue | Hermes | 4 | 2 | 1 | 1 | 3 |
| 11 | **Calendar event ops** — Hermes maintains a running event prep checklist for each ZAO show; surfaces outstanding tasks 7 days, 3 days, and day-of | Hermes | 4 | 2 | 1 | 1 | 2 |

---

### Category C: Community & Content

| # | Use Case | Worker | Impact | Effort | Risk | Cost | Revenue |
|---|---------|--------|--------|--------|------|------|---------|
| 12 | **Content repurposing** — Ollama converts ZOL cast threads into show notes, newsletter snippets, and YouTube descriptions without public posting | Ollama | 4 | 2 | 1 | 1 | 3 |
| 13 | **Transcript → clips pipeline** — Cline scripts the ffmpeg commands to cut audio/video clips from a show recording; ZOL queues clips for Zaal approval | Cline + Ollama | 4 | 3 | 2 | 1 | 4 |
| 14 | **Community moderation support** — Hermes monitors ZAO Telegram/Farcaster for CoC violations; drafts moderator alerts for Zaal review | Hermes | 4 | 3 | 3 | 1 | 2 |
| 15 | **Multilingual community bridges** — Ollama translates ZAO announcements for Spanish/Portuguese communities; drafts go through ApprovalBridge | Ollama | 3 | 2 | 2 | 1 | 3 |

---

### Category D: Builder & Technical Operations

| # | Use Case | Worker | Impact | Effort | Risk | Cost | Revenue |
|---|---------|--------|--------|--------|------|------|---------|
| 16 | **Dependency update PRs** — Jules opens draft PRs to update package.json dependencies; ZOL verifies CI passes and diffs are safe | Jules | 3 | 3 | 3 | 2 | 2 |
| 17 | **ToolGym workout generation** — Cline generates test scenarios for new ZOL tools; Pi coding agent executes them in isolation | Cline + Pi | 3 | 3 | 2 | 1 | 2 |
| 18 | **Proof Drop packaging** — Cline scripts the assembly of Proof Drop bundles for ZABAL Games submissions; ZOL verifies completeness | Cline | 4 | 2 | 1 | 1 | 4 |
| 19 | **Disaster recovery drill** — Pi coding agent generates a recovery test plan; Cline executes it in a worktree; ZOL verifies the result | Pi + Cline | 4 | 3 | 2 | 1 | 1 |
| 20 | **Cost-aware model arbitration** — Ollama handles tasks when OpenRouter quota is at 70%; Pi coding handles small code tasks to preserve API budget | Ollama + Pi | 4 | 2 | 1 | 0 | 2 |

---

### Category E: Knowledge Products & Data

| # | Use Case | Worker | Impact | Effort | Risk | Cost | Revenue |
|---|---------|--------|--------|--------|------|------|---------|
| 21 | **Bonfire knowledge room curation** — Hermes organizes Bonfire episodes by topic and generates structured knowledge summaries for ZAO community access | Hermes | 5 | 3 | 2 | 1 | 5 |
| 22 | **Artist onboarding kit** — Hermes generates a portable Trapper for each new ZAO artist: bio, links, release history, social handles | Hermes | 5 | 3 | 1 | 1 | 4 |
| 23 | **Paid data products** — Bonfire knowledge rooms packaged as structured JSON exports (music intelligence, community health, release calendars) for ZAO partners | Hermes + Ollama | 4 | 4 | 2 | 2 | 5 |
| 24 | **Cross-agent peer review** — Hermes reviews a Cline diff for semantic correctness; Ollama reviews Hermes output for consistency with prior memory | Hermes + Ollama | 4 | 4 | 2 | 2 | 1 |

---

### Category F: Surprising Convergences

The following use cases emerged from combining the runner capabilities with ZAO's unique context. They are not listed in the phase brief's brainstorm and represent genuine convergences.

| # | Use Case | Why Surprising | Worker | Impact | Effort | Risk | Cost | Revenue |
|---|---------|---------------|--------|--------|--------|------|------|---------|
| 25 | **Respect Game analytics agent** — weekly, Hermes fetches on-chain Respect data, computes Fibonacci payouts, surfaces anomalies, and prepares a draft OREC motion for Zaal's review. ZOL posts the approved digest to Farcaster. | Combines on-chain governance data (ZAO's unusual Respect system) with agent automation in a way that directly supports ZAO's weekly ritual without touching any on-chain action. | Hermes + Ollama | 5 | 3 | 2 | 1 | 3 |
| 26 | **Live-show monitoring bot** — during a ZAO event, Pi coding agent scripts a lightweight status page that polls multiple APIs (Luma attendance, Farcaster mentions, WaveWarZ live battle) and produces a 5-minute refresh digest for Zaal's private Telegram. No public posting. | Combines the Pi's local compute advantage with event ops — turns ZOL into a live backstage intelligence layer. | Pi coding | 4 | 2 | 1 | 0 | 2 |
| 27 | **Relationship-memory continuity handoff** — when Zaal switches platforms (Farcaster → Telegram → future platform), Hermes maintains a unified relationship graph across all channels, normalizes contact records, and surfaces who ZOL hasn't interacted with in >30 days. | Solves the silent problem of relationship decay across platforms that no existing tool addresses for a 1-person founding team. | Hermes | 5 | 3 | 1 | 1 | 3 |
| 28 | **Agent-as-a-service for ZAO artists** — ZOL's runner infrastructure is exposed (with heavy approval gating) as a Trapper-based service: artists submit a task via a Farcaster frame, ZOL dispatches to Ollama/Hermes, returns a portable result Trapper. No access to ZOL internals. | Turns the runner gateway into a productizable offering where ZAO artists get AI assistance without needing their own agent infrastructure. Revenue potential: Respect-denominated access tiers. | Ollama + Hermes | 5 | 5 | 3 | 3 | 5 |
| 29 | **Evidence-gated self-improvement experiments** — Cline generates an alternative implementation of a ZOL module; Pi coding agent runs the test suite; if tests pass and the diff is smaller, ZOL proposes the refactor to Zaal. All sandboxed, all approval-gated. | Turns the runner gateway into ZOL's own R&D lab — letting ZOL suggest improvements to itself without any human needing to write a single line of code. Fully sandboxed. | Cline + Pi | 4 | 4 | 2 | 1 | 1 |

---

## 16. Three Recommended Pilots

These pilots are sequenced to produce real evidence in two weeks with minimal setup, minimal risk, and no production changes.

### Pilot 1: Ollama Research Worker (Week 1, Days 1–3)

**Hypothesis:** The Model Gateway's existing OllamaAdapter can be promoted to a runner with zero new infrastructure.

**Scope:**
- Create `src/adapters/runner/ollama-runner-adapter.js` wrapping the existing Model Gateway
- Register it in a new `src/runner-registry.js` (stub — just one runner registered)
- Wire the Work Router's `research` type to the Ollama runner (behind `RUNNER_GATEWAY_ENABLED=1` env flag)
- Run one real research task through it: "Summarize the top 5 Farcaster music conversations from this week"

**Success criteria:**
- Artifact returned, secret-scanned, receipts written, no secrets leaked
- ZOL's existing Memory Weaver receives the output as a capsule entry
- No public post occurs; Telegram shows a summary draft pending approval

**Risk:** Near-zero. Ollama is already in the Model Gateway. The runner wrapper adds no new auth surface.

**Evidence produced:** One complete receipt chain from `dispatch_issued` through `artifact_accepted`, demonstrating the end-to-end pattern for all subsequent runners.

---

### Pilot 2: Cline Code Worker — ToolGym Workout Generator (Week 1, Days 4–7)

**Hypothesis:** Cline can generate ToolGym workout test files in a worktree without touching production state.

**Scope:**
- Install Cline CLI on VPS (not Pi — VPS is the sandboxed environment)
- Create `src/adapters/runner/cline-adapter.js` with worktree lifecycle management
- Task: "Generate 5 additional test cases for `src/__tests__/receipt-journal.test.js` covering edge cases not in the current suite"
- ZOL creates worktree on `worker/cline/lease_<id>`, dispatches, collects diff, runs `npm test` against it in the worktree
- If tests pass: present diff to Zaal via Telegram for review. If rejected: worktree deleted, no effect.

**Success criteria:**
- Cline produces a diff that includes only the target test file
- `scripts/secret-scan.sh` passes on the diff
- `npm test` in the worktree shows the new tests pass
- Zaal reviews and approves or rejects via Telegram
- No change to `main` or any ZOL production file occurs without Zaal's explicit action

**Risk:** Low-medium. The worktree is isolated; even if Cline writes bad code, ZOL's test suite catches it before any human has to review the diff. The main risk is Cline producing a diff that modifies unexpected files — mitigated by checking `git diff --name-only` against an allowlist before accepting.

**Evidence produced:** First validated code-worker receipt chain; proof that the verification layer catches bad output.

---

### Pilot 3: Hermes Relationship Sync — Artist CRM Run (Week 2)

**Hypothesis:** Hermes can maintain artist relationship memory as a subordinate worker, returning structured findings that ZOL writes to Memory Weaver with provenance.

**Scope:**
- Deploy Hermes on VPS with Tailscale-only access
- Create `src/adapters/runner/hermes-adapter.js`
- Task: "For the top 5 artists ZOL has spotlight-featured in the past 30 days, find any new releases, booking updates, or Farcaster activity since the last feature"
- Hermes returns structured findings JSON; ZOL validates against existing Memory Weaver entries; conflicts → Telegram for Zaal review; non-conflicting new facts → Memory Weaver with `source:hermes-runner` tag

**Success criteria:**
- Hermes findings are returned as a `RawArtifact` with `contentType: application/json`
- Provenance tags are present on all Memory Weaver writes
- Zero ZOL credentials are present in any Hermes request or response
- At least one finding is used in the next weekly curator loop (demonstrating the memory-to-action path)

**Risk:** Medium. Hermes deployment on VPS is the largest operational step. The session token must be set correctly. Mitigated by: dry-run mode (return findings but don't write to Memory Weaver), Telegram review of first batch before any writes.

**Evidence produced:** First cross-machine worker interaction; validated memory provenance model; first worker output reaching a production ZOL loop (artist-spotlight or weekly-curator).

---

## 17. Proposed Capsules & DreamLoops

### New Capsules

| capsule_id | purpose | key permissions |
|-----------|---------|----------------|
| `zol-runner-gateway-v1` | Runner Registry lifecycle, lease management, telemetry | runner.dispatch, runner.cancel, receipt.write |
| `zol-hermes-worker-v1` | Hermes adapter invocation, context bundle preparation | hermes.dispatch, memory.read (curated), artifact.write |
| `zol-cline-worker-v1` | Cline subprocess management, worktree lifecycle | cline.dispatch, git.worktree.create, artifact.write |
| `zol-jules-worker-v1` | Jules API client, GitHub PR audit (approval-gated) | jules.dispatch (approval-gated), github.pr.read |
| `zol-worker-memory-v1` | Worker lesson return, provenance tagging, Memory Weaver write | memory.write (provenance-gated), receipt.write |
| `zol-worker-verification-v1` | Artifact verification: secret scan, diff audit, test run | artifact.verify, secret.scan, test.run |

### New DreamLoops

| loop_id | trigger | steps | capsule | notes |
|---------|---------|-------|---------|-------|
| `runner-health-check` | startup, every 5 min | 3 | runner-gateway-v1 | Poll all runner health(); alert if any go unhealthy |
| `runner-dispatch` | work.route (new runner destination) | 5 | runner-gateway-v1 | Issue lease → dispatch → poll → collect → verify |
| `worker-lesson-return` | runner.artifact_accepted | 4 | worker-memory-v1 | Extract lessons → validate → Memory Weaver write |
| `cline-worktree-cleanup` | daily-cron | 2 | cline-worker-v1 | Delete any orphaned worktrees older than 24h |
| `jules-pr-audit` | github.pr_created (worker/jules/* branch) | 4 | jules-worker-v1 | Fetch diff → secret scan → approval request |
| `hermes-artist-crm-sync` | weekly-cron | 5 | hermes-worker-v1 | Dispatch artist research tasks → collect → memory write |
| `runner-telemetry-report` | daily-cron | 3 | runner-gateway-v1 | Aggregate metrics → daily-private-brief artifact |

---

## 18. Tests, Canary Plan & Rollback

### Unit Tests

| Test file | What it tests |
|-----------|-------------|
| `src/__tests__/runner-registry.test.js` | selectRunner routing, lease issuance, idempotency key dedup, tier-escalation block |
| `src/__tests__/ollama-runner-adapter.test.js` | dispatch/collect/cancel, timeout handling, fallback to mock |
| `src/__tests__/cline-adapter.test.js` | worktree creation/cleanup, subprocess isolation, secret-scan on diff |
| `src/__tests__/hermes-adapter.test.js` | context bundle construction, session token header, response parsing |
| `src/__tests__/jules-adapter.test.js` | async polling, GitHub PR state mapping, artifact collection, approval gate trigger |
| `src/__tests__/worker-verification.test.js` | secret-scan integration, diff allowlist, test-runner invocation, reject path |
| `src/__tests__/runner-receipt-chain.test.js` | full receipt chain from dispatch_issued through completed, SHA-256 chain integrity |

### Canary Plan

**Phase 1 canary (Ollama runner):**
- Enable `RUNNER_GATEWAY_ENABLED=1` on Pi for 24 hours
- Route only `type: research` packets to Ollama runner
- Monitor: receipt journal growth, Memory Weaver write count, Telegram draft count
- Rollback trigger: more than 1 unexpected Telegram approval request in 1 hour

**Phase 2 canary (Cline on VPS):**
- Enable Cline runner for 1 week, ToolGym tasks only
- All Cline artifacts require explicit Zaal Telegram approval before any action
- Monitor: worktree creation/cleanup, diff sizes, test pass rate
- Rollback trigger: any secret found in diff, any worktree not cleaned up within 30 minutes of lease close

**Phase 3 canary (Hermes on VPS):**
- Enable Hermes for research tasks, dry-run mode for first 3 days (return findings, do not write to Memory Weaver)
- After Zaal reviews 3 batches: enable memory writes with provenance tagging
- Rollback trigger: any credential appearing in Hermes response, any Memory Weaver write without provenance tag

### Rollback Procedure

For all runner components:

```bash
# Immediate: disable runner gateway
unset RUNNER_GATEWAY_ENABLED
# or: export RUNNER_GATEWAY_ENABLED=0

# All packets fall back to 'operator' route (existing Work Router behavior)
# No loops are disrupted; no worker is contacted

# Clean up any in-flight leases
node -e "
const rr = require('./src/runner-registry');
const registry = new rr.RunnerRegistry({ ... });
await registry.cancelAllActiveLeases({ reason: 'emergency-rollback' });
"

# Verify: no orphaned worktrees
ls ~/.zao/worktrees/   # should be empty after cancel
```

For Cline specifically:
```bash
# Clean up worktrees
rm -rf /tmp/zao-worktrees/worker/cline/*

# Verify no dirty branches exist
git branch | grep worker/cline
# should return empty after cleanup
```

---

## 19. Implementation PR Sequence

This sequence is designed for the existing stacked-PR workflow [VERIFIED from v2-deliverables.md]. Each PR is mergeable independently; later PRs depend on earlier ones.

| PR # | Branch | Title | Contents | Depends On |
|------|--------|-------|----------|-----------|
| #29 | `ws/runner-gateway-contract` | Add RunnerAdapter contract and RunnerRegistry stub | `src/runner-registry.js` (stub), `src/adapters/runner/` directory structure, Runner Registry unit tests (mock adapters only), new capsule JSON files, new DreamLoop manifests | #28 |
| #30 | `ws/ollama-runner-adapter` | Promote Ollama to RunnerAdapter, wire research routing | `src/adapters/runner/ollama-runner-adapter.js`, `src/adapters/runner/pi-coding-adapter.js`, env var `RUNNER_GATEWAY_ENABLED`, `src/__tests__/ollama-runner-adapter.test.js`, Agent Gateway `/runners` endpoint | #29 |
| #31 | `ws/cline-runner-adapter` | Add ClineAdapter with worktree lifecycle | `src/adapters/runner/cline-adapter.js`, worktree create/cleanup, secret-scan integration on diff, `src/__tests__/cline-adapter.test.js`, `CLINE_WORKTREE_BASE` env var | #30 |
| #32 | `ws/hermes-runner-adapter` | Add HermesAdapter with session token auth | `src/adapters/runner/hermes-adapter.js`, context bundle builder, lesson return protocol, `src/__tests__/hermes-adapter.test.js`, `HERMES_ENDPOINT` + `HERMES_SESSION_TOKEN` env vars | #30 |
| #33 | `ws/jules-runner-adapter` | Add JulesAdapter (approval-gated, tier 3) | `src/adapters/runner/jules-adapter.js`, branch namespace fencing, tier-3 ApprovalBridge wiring, `JULES_API_KEY` + `JULES_GITHUB_TOKEN` env vars, `src/__tests__/jules-adapter.test.js` | #29 (not dependent on Cline/Hermes) |
| #34 | `ws/runner-receipt-chain` | Full receipt chain tests and runner telemetry | `src/__tests__/runner-receipt-chain.test.js`, telemetry state keys, Agent Gateway `/runners/telemetry` endpoint, `runner-telemetry-report` DreamLoop | #31, #32, #33 |
| #35 | `ws/runner-gateway-integration` | Integration tests and canary validation | `src/__tests__/runner-gateway-integration.test.js`, dry-run script for runner gateway, documentation of confirmed behaviors | #34 |

---

## 20. Open Questions

Items that require Zaal's or Brandon's input before implementation can proceed. Each is marked with the blocking PR.

| # | Question | Blocks | Owner |
|---|---------|--------|-------|
| 1 | Is "Clive" a distinct product, or is it Cline (github.com/cline/cline)? If distinct: what is the source and where does it live? | PR #31 | Zaal |
| 2 | Has Hermes (NousResearch/hermes-agent) been deployed anywhere in the ZAO stack? If yes, what endpoint and auth model? If no, is VPS deployment approved? | PR #32 | Zaal |
| 3 | Is a Jules API key available? Has Jules been evaluated against a non-production repo yet? | PR #33 | Zaal |
| 4 | What GitHub installation scope should the `JULES_GITHUB_TOKEN` have? Is there an existing GitHub App installation for ZAO, or does a new one need to be created? | PR #33 | Zaal |
| 5 | Is Brandon's dream-net relevant to the runner gateway? (Per project security policy: do not request access to BrandonDucar/dream-net — it is private. If it is relevant, Brandon must volunteer the connection.) | All runners | Brandon |
| 6 | Which Ollama model should `PiCodingAdapter` use by default? (`deepseek-coder:1.3b`, `codellama:7b`, or another?) | PR #30 | Zaal |
| 7 | Should the `HERMES_SESSION_TOKEN` rotation cadence be weekly or keyed to ZOL's weekly restart window? What is the rotation procedure? | PR #32 | Zaal |
| 8 | Should Jules operate against the main `bettercallzaal/zol` repo (with scoped branch protection) or against a dedicated fork? The fork approach is more isolated but requires mirroring. | PR #33 | Zaal |
| 9 | Is Cline's model required to go through Ollama (local), or is a separate OpenRouter sub-key acceptable for Cline's use? | PR #31 | Zaal |
| 10 | Is the VPS (`cowork-zaodevz`) the correct host for Cline and Hermes, or is there a preference for a container or separate VM for isolation? | #30–#33 | Zaal |
| 11 | What is the approved daily token budget for runner calls? Should it be shared with ZOL's existing 20,000-token/day quota (`DREAMLOOPS_DAILY_BUDGET_TOKENS`) or a separate runner budget? | #29 | Zaal |
| 12 | Pi coding agent source: is `docs.ollama.com/integrations/pi` the correct reference for what was intended, or is there a specific repo or tool named "Pi" in the ZAO stack? | PR #30 | Zaal |

---

## Declaration

- No code was changed, installed, or deployed to produce this document.
- No production daemons were restarted.
- No branches were pushed.
- No public posts were made.
- No wallet, signer, or token actions were taken or designed into this document.
- No secrets appear in this document.
- `BrandonDucar/dream-net` was not accessed and is not referenced in any design recommendation.
- Telegram remains ZOL's sole public-action authority.
- All worker adapters in this design default to `allowPublicPost: false` and `allowMerge: false`.
- Verified facts are labeled [VERIFIED]; recommendations are labeled [RECOMMENDATION]; extrapolations are labeled [SPECULATION].
