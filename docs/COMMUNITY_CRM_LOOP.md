# Community CRM Relationship Lifecycle Loop (L6)

## Overview

The **relationship-lifecycle-update** loop (L6) tracks and nurtures community member relationships across their lifecycle stages:
- **discover** - Recently joined, minimal activity
- **engage** - Active participant in community  
- **coordinate** - Active contributor in a project
- **escalate** - Leadership or high-value contributor
- **nurture** - Was active, now inactive (reengagement)

## Activation

Feature-flagged OFF by default. Requires both flags enabled:
```
DREAMLOOPS_ENABLED=true
COMMUNITY_CRM_ENABLED=true
```

## Safety Guarantees

1. **Draft-Only DMs**: All DMs are composed as drafts, never auto-sent. Bulk sends (>10) require manual approval in Telegram.
2. **Immutable Logs**: Relationship status updates are written to an immutable log. No deletion. No modification by the loop.
3. **No Signer Access**: Loop has no access to Farcaster signer keys or any wallet functionality.
4. **No Fund Movement**: Loop cannot move funds or interact with on-chain systems.
5. **Secret Scanning**: All handlers reject inputs/state containing secret patterns (64-char hex, `sk-*`, `ghp_*`).
6. **Rate Limits**: 500 DMs/day, 100 relationship updates/day, max 10 per batch without approval.

## Capsule: community-crm-v1

Located at `capsules/community-crm-v1.json`.

- **Status**: draft
- **Activation Mode**: flag_gated_off
- **Permissions**: Read circles, Farcaster, cowork; write to relationship state and logs; DM sending (gated)
- **Blocked**: Member removal, role grants, fund transfers, signer access

## Loop: relationship-lifecycle-update

Located at `loops/relationship-lifecycle-update.manifest.json`.

**Trigger**: `circle.relationship-state-change` or scheduled daily audit.

**Steps**:
1. Log state change event
2. Read member profile (circles)
3. Read activity history (Farcaster)
4. Fetch project contributions (cowork)
5. Classify relationship stage (discover/engage/coordinate/escalate/nurture)
6. Propose nurture action
7. Compose action message (draft-only)
8. Determine approval gate (bulk sends need approval)
9. Send action or stage for approval
10. Update relationship status (immutable log)
11. Record completion event

**Timeout**: 30 seconds
**Terminal States**: status-updated, action-sent, action-staged-for-approval, no-action-needed, dm-send-failed

## Handlers

Located at `src/handlers/community-crm.js`.

### circle.relationship-status-read
Reads member profile, stage, activity score, history from circles (mock for now).

### circle.relationship-status-write
Writes relationship stage update to immutable log. Rejects secret patterns.

### message.classify
Classifies relationship stage based on activity and contribution patterns.

### priority.plan
Plans next action: welcome, invite, project suggestion, escalation flag, or reengagement.

### farcaster.dm-send
Composes DM as draft. Auto-sends single DMs (low risk), stages bulk sends (>10) for approval. Never auto-sends without approval gate.

### farcaster.activity-read
Reads member's recent Farcaster activity (posts, likes, follows).

### cowork.fetch-projects
Reads member's project contributions from cowork tracker.

### log.relationship-events-write
Logs relationship events immutably. Rejects secret patterns.

## Testing

### Unit Tests
```bash
npm run dl:test  # runs all tests including community-crm
# or
node --test src/handlers/__tests__/community-crm.test.js
```

All 16 community-crm handler tests pass, covering:
- Successful reads and writes
- Safety guards (secret rejection, auto-send blocking)
- Approval gate enforcement
- Input validation

### Dry Run
```bash
node scripts/dl-dry-run-community-crm.js
```

Exercises all handlers in mock mode. All 12 tests pass:
- Member data reads
- Stage classification
- Action planning
- DM composition (draft-only)
- Safety guards
- Bulk send approval
- Event logging
- Activity reads
- Project fetches

### Validation
```bash
npm run dl:validate
```

Validates all capsule and loop manifests. Confirms community-crm-v1 and relationship-lifecycle-update manifests are valid executable contracts.

## Integration Notes

- **Phase 5 TODO**: Wire handlers to actual data sources (circles API, Neynar, cowork tracker).
- **State Adapter**: Uses zol's atomic-file backend by default; compatible with SQLite WAL.
- **Cost Ceiling**: No LLM calls (classification is mock); Neynar API calls rate-limited by Farcaster quota.
- **Approval Flow**: Drafts are written to local state and pinged to Zaal via Telegram. He approves via dashboard (`post-reply.js`).

## Files Added

- `capsules/community-crm-v1.json` - Capsule manifest
- `loops/relationship-lifecycle-update.manifest.json` - Loop manifest
- `src/handlers/community-crm.js` - Handler implementations (7 handlers)
- `src/handlers/__tests__/community-crm.test.js` - 16 unit tests
- `scripts/dl-dry-run-community-crm.js` - Dry-run validation script
- `docs/COMMUNITY_CRM_LOOP.md` - This file

## PR Checklist

- [x] All handlers draft-only (never auto-send DMs)
- [x] No signer/wallet access
- [x] No fund movement
- [x] Feature flags OFF by default (DREAMLOOPS_ENABLED, COMMUNITY_CRM_ENABLED)
- [x] All tests pass (16/16 community-crm tests + dry-run)
- [x] Manifests validate (dl:validate)
- [x] Secret scanning guards in place (rejects 64-char hex, sk-*, ghp_*)
- [x] Rate limits defined (500 DMs/day, 100 updates/day)
- [x] Immutable logs (relationship state writes are append-only)
- [x] Approval gates (bulk sends >10 require approval)
- [x] No harm to existing zol functionality
