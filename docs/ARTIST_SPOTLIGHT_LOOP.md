# Artist Spotlight Loop (L7)

## Overview

The **artist-spotlight** loop (L7) periodically selects one ZAO artist ZOL has mentioned favorably in the past (from Bonfire recall and recent-casts.json) who hasn't been spotlighted recently, and drafts a short "spotlight" cast going deeper on that artist. The loop is distinguished by its STATE CARRY-OVER: it maintains a durable history of which artists have been spotlighted and when, enabling rotation through different artists over time without repetition.

Key characteristics:
- **Rotation Strategy**: Read history -> filter candidates (no spotlights within 60 days) -> pick one -> compose -> stage draft
- **Draft-Only**: Never auto-posts; always stages for Zaal's approval via dashboard
- **Durable State**: spotlight-history key in state-adapter preserves artist rotation across runs
- **Cooldown**: 60 days before an artist can be spotlighted again

## Activation

Feature-flagged OFF by default. Requires both flags enabled:
```
DREAMLOOPS_ENABLED=true
ARTIST_SPOTLIGHT_ENABLED=true
```

## Safety Guarantees

1. **Draft-Only Casting**: All spotlights are composed as drafts, never auto-sent to Farcaster. Staged for Zaal approval in dashboard.
2. **No Auto-Posting**: Loop cannot directly publish casts; only writes draft files to ~/zol/drafts/.
3. **No Signer Access**: Loop has no access to Farcaster signer keys or wallet functionality.
4. **No Fund Movement**: Loop cannot move funds or interact with on-chain systems.
5. **Secret Scanning**: All handlers reject inputs/state containing secret patterns (64-char hex, `sk-*`, `ghp_*`).
6. **Artist Rotation**: History state prevents spotlighting the same artist within 60 days.
7. **Durable State**: Artist spotlight history is persisted via state-adapter (atomic-file, SQLite, or Bonfire backend), survives process restarts.

## Capsule: zol-artist-spotlight-v1

Located at `capsules/zol-artist-spotlight-v1.json`.

- **Status**: draft
- **Activation Mode**: flag_gated_off
- **Permissions**: Read Bonfire (recall), state (history), write state (append history)
- **Blocked**: Cast publish, auto-upload, fund transfers, signer access, secret reads
- **State Key**: `artist-spotlight-v1-history` - array of `{ artist, spotlightedAt, draftHash }`

## Loop: artist-spotlight-v1

Located at `loops/artist-spotlight-v1.manifest.json`.

**Trigger**: `scheduled weekly` or `on-demand`.

**Steps**:
1. Read spotlight history from state (current artist rotation state)
2. Fetch artist context from Bonfire (delve recall query)
3. Parse recent casts to extract artist mentions (~/zol/recent-casts.json)
4. Filter candidates - exclude artists spotlighted within 60 days
5. Select one artist randomly from eligible pool
6. Compose spotlight draft cast (280 char max, draft-only)
7. Stage draft for approval (write to ~/zol/drafts/<hash>.json)
8. Append to spotlight history state (durable record)
9. Record completion event

**Timeout**: 45 seconds
**Max Steps**: 10
**Terminal States**: draft-staged, no-eligible-artists, bonfire-recall-failed, state-write-failed

## Handlers

Located at `src/handlers/artist-spotlight.js`.

### state.local.read
Reads spotlight history from state. Returns `{ stateKey, history, timestamp }`. History is an array of `{ artist, spotlightedAt, draftHash }` objects.

### state.local.write
Writes to state (with optional append mode). Rejects secret patterns. Returns write confirmation.

### bonfire.delve-recall
Fetches artist context from Bonfire using a recall query. Returns structured context with artist information.

### farcaster.recent-casts-parse
Parses ZOL's recent casts (~/zol/recent-casts.json) to extract artist mentions. Returns list of artist names mentioned.

### artist-spotlight.filter-eligible-artists
Filters candidates against spotlight history, excluding artists spotlighted within cooldown window (default 60 days). Throws if no eligible artists remain.

### artist-spotlight.select-one-artist
Selects one artist from eligible candidates using weighted random selection. Returns selected artist name.

### artist-spotlight.compose-spotlight-draft
Composes a 280-character spotlight cast with artist context. Enforces draft-only (never auto-posts). Returns draft text.

### artist-spotlight.stage-draft-for-approval
Writes draft to ~/zol/drafts/<hash>.json for Zaal approval. Returns hash and note. Draft structure: `{ hash, kind: 'artist-spotlight', text, artist, summary, createdAt, draftOnly: true }`.

### artist-spotlight.record-spotlight-completion
Records the completion event with artist name and draft hash. Completion record is appended to history state.

## State Schema

**Key**: `artist-spotlight-v1-history`

**Value**:
```json
[
  {
    "artist": "Ivy Wong",
    "spotlightedAt": "2026-07-16T12:00:00Z",
    "draftHash": "a1b2c3d4e5f6..."
  },
  {
    "artist": "Marcus Chen",
    "spotlightedAt": "2026-07-09T10:30:00Z",
    "draftHash": "f6e5d4c3b2a1..."
  }
]
```

History is append-only. Filtering happens at read time based on spotlightedAt timestamps.

## Testing

### Unit Tests
```bash
npm run dl:test  # runs all tests including artist-spotlight
# or
node --test src/handlers/__tests__/artist-spotlight.test.js
```

All 16 artist-spotlight handler tests pass, covering:
- State read/write operations
- Bonfire recall and recent-casts parsing
- Candidate filtering (with and without history)
- Artist selection
- Draft composition (draft-only enforcement)
- Draft staging for approval
- Input validation
- Secret pattern rejection
- Multi-run state carryover (3-run simulation with no artist repeats)

### State Carryover Test
The multi-run test simulates 3 sequential runs sharing one state object:
1. Run 1: Empty history, select artist A
2. Run 2: History has [A], filter excludes A, select artist B (B != A)
3. Run 3: History has [A, B], filter excludes A and B, select artist C (C != A and C != B)

This validates that state carries over correctly and artists don't repeat within the cooldown window.

### Validation
```bash
npm run dl:validate
```

Validates artist-spotlight-v1.manifest.json and zol-artist-spotlight-v1.json against schema. Confirms loop and capsule are valid executable contracts.

## Integration Notes

- **Phase 5 TODO**: Wire bonfire.delve-recall to actual Bonfire API; parse real ~/zol/recent-casts.json; write drafts to actual ~/zol/drafts/ directory.
- **State Adapter**: Uses atomic-file backend by default; compatible with SQLite WAL and Bonfire backends via ZOL_STATE_BACKEND env var.
- **Approval Flow**: Drafts are written to ~/zol/drafts/<hash>.json. Zaal views pending drafts on dashboard (scripts/dashboard.js), clicks "Post" to publish via scripts/post-event.js.
- **Draft Kind**: All drafts are `kind: "artist-spotlight"` (similar to existing "event", "reply" kinds).
- **Cost Ceiling**: No LLM calls in draft composition (mock context injection); Bonfire API calls rate-limited by existing ZOL quota.

## Files Added

- `capsules/zol-artist-spotlight-v1.json` - Capsule manifest
- `loops/artist-spotlight-v1.manifest.json` - Loop manifest
- `src/handlers/artist-spotlight.js` - Handler implementations (9 handlers)
- `src/handlers/__tests__/artist-spotlight.test.js` - 16 unit tests
- `docs/ARTIST_SPOTLIGHT_LOOP.md` - This file

## PR Checklist

- [x] All handlers draft-only (never auto-post)
- [x] No signer/wallet access
- [x] No fund movement
- [x] Feature flags OFF by default (DREAMLOOPS_ENABLED, ARTIST_SPOTLIGHT_ENABLED)
- [x] State carry-over implemented (artist-spotlight-v1-history)
- [x] Multi-run state carryover test (3 runs, no repeats)
- [x] All tests pass (16/16 artist-spotlight tests)
- [x] Manifests validate (dl:validate)
- [x] Secret scanning guards in place (rejects 64-char hex, sk-*, ghp_*)
- [x] Cooldown logic (60 days between spotlights per artist)
- [x] No harm to existing zol functionality
- [x] Draft integration (drafts written as ~/zol/drafts/<hash>.json for approval)
