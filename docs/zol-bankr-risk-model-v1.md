# ZOL × Bankr: Risk Model Decision Framework v1

**Status:** Awaiting Zaal decision  
**Constraint:** NO trading code may be written until these 4 questions are answered.  
**Why the constraint exists:** ZOL's core safety invariant is that it cannot sign wallet transactions or move funds without explicit human approval for each action. Any Bankr integration that involves fund movement must be gated and auditable to the same standard as Farcaster posts.

> "Gated — your call." — board task d27b785c

---

## The Invariant (non-negotiable)

ZOL currently guarantees:
- **No signer change.** The Farcaster signer (`~/.openclaw/farcaster-credentials.json`) is read-only to ZOL.
- **No wallet action.** ZOL has no ability to sign transactions, transfer tokens, or call contract methods.
- **All consequential actions are Telegram-approved.** The ApprovalBridge enforces one-use, fails-closed approval before any tool call marked `requiresApproval`.

Any Bankr integration path must preserve all three invariants or the scope must be explicitly expanded with Zaal's written approval.

---

## The 4 Questions

---

### Q1: Autonomous vs. Approve

**Question:** Should ZOL execute Bankr-triggered actions autonomously (fully automated), or should every fund-related action route through the existing Telegram approval flow?

**Options:**

| Option | Description | Risk |
|--------|-------------|------|
| A. Fully autonomous | ZOL executes buys/sells without approval | HIGH — violates ZOL's core invariant; fund loss risk if model/loop misbehaves |
| B. Approve every action | Each fund move requires Telegram confirmation (status quo model) | LOW — maintains full human control; latency on market actions |
| C. Pre-approved playbook | Zaal pre-approves a specific set of moves (e.g., max $X per buy, only ETH/USDC, specific triggers). ZOL executes within those bounds automatically. | MEDIUM — bounded autonomy; playbook must be explicit and auditable |

**Recommendation: Option B or C.**  
Option A violates ZOL's invariant and should not be built. Option B is safest for a first integration. Option C can be considered after Option B proves stable and a playbook is written.

**Your call:** B / C / neither (don't integrate Bankr)

---

### Q2: Spend Limits and Which Wallet

**Question:** What wallet will ZOL use, and what are the hard spend limits per action, per day, and in total?

**Context:** ZOL currently has no wallet private key loaded. If Bankr integration adds one, it must be isolated from the Farcaster signer (principle of least privilege).

**Options:**

| Option | Wallet | Limits |
|--------|--------|--------|
| A. Dedicated Bankr wallet (isolated from Pi signer) | New separate key, never on the Pi or near the Farcaster signer | Cap: Zaal sets explicit max per-action + daily ceiling |
| B. Same wallet as existing ZAO treasury | Shares key with existing infra | RISKY — wider blast radius if ZOL is compromised |
| C. No wallet at all — ZOL drafts actions only, human executes | ZOL produces signed-off trade proposals, Zaal manually submits | Zero ZOL custody |

**Recommendation: Option A or C.**  
If fund movement is desired, Option A with a dedicated low-balance wallet and hard per-action limits is the lowest-risk path that preserves ZOL's isolations. Option C (draft-only) is even safer and unblocks any research or tracking features without custody risk.

**Your call (fill in):**  
- Wallet option: A / C / neither  
- Max per action: $______  
- Daily ceiling: $______  
- Total portfolio ceiling: $______

---

### Q3: API vs. Cast Commands

**Question:** Should ZOL trigger Bankr actions via a Bankr API/SDK, or through cast commands (Farcaster-native interface)?

**Options:**

| Option | Mechanism | Notes |
|--------|-----------|-------|
| A. Bankr API/SDK | Direct programmatic calls | Requires storing a Bankr API key; actions are instant; full audit trail possible |
| B. Cast commands | ZOL posts a Farcaster cast in the Bankr format (e.g., `/buy 10 ETH`) | No new keys needed; Bankr's own system interprets; reply confirms execution |
| C. Hybrid: read via API, execute via cast | ZOL queries Bankr API for portfolio state, executes via cast commands | Lower key footprint for execution; still needs read-key for state |

**Recommendation: Option B or C (cast-first).**  
Option B keeps ZOL from needing Bankr API credentials. Cast commands are auditable on Farcaster. If the Bankr cast interface is reliable, this is the safest implementation path. Option A is fine if the Bankr API key can be stored with the same security as the OpenRouter key (`~/.zao/private/`).

**Your call:** A / B / C

---

### Q4: Co-located with Pi Signer vs. Isolated

**Question:** Should the Bankr integration run on the Pi (alongside the Farcaster signer), or on a separate machine/environment?

**Context:** The Pi currently holds the Farcaster signer private key. Co-locating fund-moving capability raises the blast radius if the Pi is compromised.

**Options:**

| Option | Deployment | Risk |
|--------|------------|------|
| A. On the Pi, same environment | Simplest; one machine to manage | If Pi is compromised, attacker has both social and financial access |
| B. On the Pi, separate process with its own env | Slightly isolated; different `.env` file and process owner | Reduces but doesn't eliminate co-location risk |
| C. Separate machine / VPS | Physical isolation; ZOL on Pi communicates with Bankr runner via authenticated API | Best security posture; more infrastructure to manage |
| D. Cloud function / serverless | Ephemeral; no persistent key on Pi | Requires secrets management in cloud; adds latency |

**Recommendation: Option B for low-stakes start; Option C if real money is involved.**  
The Pi's existing threat model is low (it's a home device running zolbot). If spend limits are small (e.g., <$100 total), Option B is acceptable. If Bankr integration ever touches hundreds of dollars, Option C is required.

**Your call:** A / B / C / D

---

## Summary Decision Form

Copy this, fill it in, and return it to unblock implementation:

```
Q1 (autonomous vs. approve): _____
  If C (playbook): describe the playbook briefly: _____

Q2 (spend limits / wallet): _____
  Wallet: dedicated / shared / draft-only
  Max per action: $___
  Daily ceiling: $___
  Total ceiling: $___

Q3 (API vs. cast): _____

Q4 (co-location): _____
  If B or C: will you create the dedicated Bankr env/machine? yes / no

Approved for implementation: yes / no
If yes, approved by: Zaal  Date: ______
```

---

## Implementation Gates (enforced regardless of decision)

No matter which options are chosen:
1. **No signer change.** The Farcaster signer key must not be used for any Bankr action. Ever.
2. **All fund moves via ApprovalBridge.** Every Bankr action that touches funds must call `bridge.consume(approvalId)` before execution.
3. **Receipt required.** Every executed Bankr action emits a receipt to the ReceiptJournal.
4. **Secret hygiene.** Any Bankr API key must be in `~/.zao/private/`, never in `.env.example`, tests, or Git.
5. **No autonomous deployment.** The Bankr integration goes through the same PR review process as all other ZOL changes.

---

*This document does not authorize any implementation. Implementation begins only after Zaal completes the decision form above.*
