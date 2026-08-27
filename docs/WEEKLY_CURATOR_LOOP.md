# Weekly Curator Recap Loop (L7)

## Overview

The **weekly-curator-v1** loop (L7) runs once per week (every Monday 6am UTC), reviews ZOL's last 7 days of posted casts from `~/zol/recent-casts.json`, contextualizes them with Bonfire ZAO ecosystem data, selects the single best find of the week, and drafts a weekly recap cast highlighting that selection. The draft is never auto-posted - it is always staged to `~/zol/drafts/<hash>.json` for Zaal's review and approval before posting (via the existing `post-event.js` approval flow).

**Key features**:
- Reads recent-casts.json (ZOL's hourly posts from the past 7 days)
- Recalls Bonfire context to understand weekly ZAO ecosystem activity
- Classifies and ranks casts to identify the best find
- Composes a 280-char weekly recap cast (or silent if nothing fresh)
- Stages draft to `~/zol/drafts/` for human approval (never auto-posts)
- Tracks already-summarized weeks in state to avoid duplicate highlights

## Activation

Feature-flagged OFF by default. Requires both flags enabled:
```
DREAMLOOPS_ENABLED=true
WEEKLY_CURATOR_ENABLED=true
```

## Safety Guarantees

1. **Never Auto-Posts**: All weekly recaps are composed as drafts, staged to `~/zol/drafts/` for Zaal's approval. The loop has zero capability to post to Farcaster. Uses same approval flow as event-casting (`post-event.js`).
2. **No Signer Access**: Loop has no access to Farcaster signer keys, wallet functionality, or fund movement.
3. **State Carryover**: Tracks already-summarized calendar weeks to prevent duplicate highlights. If a week has been summarized, the loop skips it on retry.
4. **Secret Scanning**: All handlers reject inputs/state containing secret patterns (64-char hex, `sk-*`, `ghp_*`).
5. **Silence on No-Fresh Content**: If Bonfire context is empty or all recent casts are too similar to previous weeks, loop can output nothing (silent run).
6. **Similarity Guard**: Checks that the weekly recap is not too similar to previous recaps (>50% word overlap = skip and post nothing).

## Capsule: zol-weekly-curator-v1

Located at `capsules/zol-weekly-curator-v1.json`.

- **Status**: draft
- **Activation Mode**: flag_gated_off
- **Permissions**: Read state and Farcaster activity, write state, classify messages, plan actions, log events
- **Blocked**: Cast sending, DM sending, fund transfers, signer access

## Loop: weekly-curator-v1

Located at `loops/weekly-curator-v1.manifest.json`.

**Trigger**: `scheduled weekly (Monday 6am UTC)`.

**Steps**:
1. Read state (check already-summarized weeks)
2. Check if this week has already been done (carryover prevent duplicates)
3. Read recent casts (7-day window from recent-casts.json)
4. Recall Bonfire context (ZAO ecosystem activity this week)
5. Select highlight (classify and rank casts to pick the best find)
6. Compose recap text (draft 280-char weekly recap)
7. Check similarity (ensure draft is not too similar to previous recaps)
8. Stage draft (write to state as weekly-curator-draft, draftOnly=true)
9. Update state carryover (mark week as summarized)
10. Log completion event

**Timeout**: 60 seconds
**Terminal States**: recap-drafted, draft-staged-for-approval, no-action-needed, duplicate-week, failure

## Handlers

Located at `src/handlers/weekly-curator.js`.

### state.local.read
Reads `weekly-curator-state` from state store, returns already-summarized weeks and last-run timestamp.

### state.local.write
Writes `weekly-curator-state` to persist week-summarization tracking (immutable log). Special handling for `weekly-curator-draft` to enforce draftOnly=true.

### farcaster.activity-read
Reads ZOL's recent casts (source: recent-casts-file, 7-day window) or recalls Bonfire context (source: bonfire-recall). Returns casts with text and timestamp, or Bonfire episode summary.

### message.classify
Classifies recent casts to select the best find of the week (contextKey: weekly-curator-highlight). Also checks if draft is too similar to previous recaps (contextKey: weekly-recap-similarity, uses word-overlap guard like zol-daily.js).

### priority.plan
Plans the recap composition. Checks if the current calendar week has already been summarized (scope: weekly-recap-check). Composes draft text (scope: weekly-recap-composition, enforces draftOnly=true).

### log.zol-events-write
Logs weekly recap events immutably (eventType: weekly-recap-drafted). Rejects secret patterns.

## Testing

### Unit Tests
```bash
npm run dl:test  # runs all tests including weekly-curator
# or
node --test src/handlers/__tests__/weekly-curator.test.js
```

All tests cover:
- State read/write (initial state, persistence, secrets rejection)
- Draft-only enforcement (rejects auto-send, stages for approval)
- Recent cast reads (7-day window, mock casts)
- Bonfire recall (ZAO context)
- Highlight classification and selection
- Similarity checking (not too similar to previous recaps)
- Week-already-done checking (prevents duplicate summaries)
- Event logging and secret rejection
- Full success path (read -> select -> compose -> stage)

### Validation
```bash
npm run dl:validate
```

Validates all capsule and loop manifests. Confirms zol-weekly-curator-v1 and weekly-curator-v1 manifests are valid executable contracts.

## Integration Notes

- **Phase 5 TODO**: Wire handlers to actual data sources (~/zol/recent-casts.json, Bonfire API).
- **Drafts**: Staged to `~/zol/drafts/<hash>.json` matching post-event.js format: `{ hash, kind: 'weekly-recap', text, moment/summary, ... }`.
- **Approval Flow**: Drafts are written to state and Zaal reviews them via the existing dashboard (`post-reply.js`, `post-event.js`). He approves via `post-event.js <id>`.
- **State Adapter**: Uses zol's atomic-file backend by default; compatible with SQLite WAL for durability.
- **Cost Ceiling**: No LLM calls (classification is mock); Bonfire API calls rate-limited.
- **Silent Runs**: Loop can output nothing if Bonfire context is empty or all casts are too similar to previous weeks.

## Files Added

- `capsules/zol-weekly-curator-v1.json` - Capsule manifest
- `loops/weekly-curator-v1.manifest.json` - Loop manifest
- `src/handlers/weekly-curator.js` - Handler implementations (6 handlers)
- `src/handlers/__tests__/weekly-curator.test.js` - 18 unit tests
- `docs/WEEKLY_CURATOR_LOOP.md` - This file

## PR Checklist

- [x] All handlers draft-only (never auto-send casts)
- [x] No signer/wallet access
- [x] No fund movement
- [x] Feature flags OFF by default (DREAMLOOPS_ENABLED, WEEKLY_CURATOR_ENABLED)
- [x] All tests pass (18/18 weekly-curator tests)
- [x] Manifests validate (dl:validate)
- [x] Secret scanning guards in place
- [x] State carryover prevents duplicate weeks
- [x] Similarity guard prevents near-duplicate recaps
- [x] Staged drafts match post-event.js format
- [x] No harm to existing zol functionality
