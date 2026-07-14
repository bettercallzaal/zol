# ZOL Calendar-Aware Casting - Design Spec

Date: 2026-07-14
Status: Approved by Zaal, proceeding to implementation.

## Purpose

ZOL watches the ZAO event calendar (Luma) and drafts Farcaster casts promoting
upcoming events, in ZOL's voice. Every draft goes through the existing
Telegram approval gate before it posts - no new auto-posting path.

## Calendar Source

`https://api.lu.ma/ics/get?entity=calendar&id=cal-jPH4al7AMlXzdNN` - the
public ICS feed for the ZAO Luma calendar (luma.com/zao). Confirmed live:
returns `200`, `content-type: text/calendar`, no auth, filename
`ZAOCALENDAR.ics`. No webhook exists for this feed; polling is the only way
to detect new events.

Default lives in code; overridable via `CALENDAR_ICS_URL` env var so ZOE
(the orchestrator, watching the same calendar for Zaal's briefings) and ZOL
stay pointed at one source without hardcoding it twice.

VEVENT fields used: `UID`, `SUMMARY`, `DTSTART`, `LOCATION` (event URL),
`STATUS`. Events with `STATUS:CANCELLED` are skipped. Folded (continuation)
lines are unfolded before parsing. No external ICS library - a small
hand-rolled parser is enough for these five fields.

## Components

### `src/ics-lib.js` (new)

Fetch + parse the ICS feed. Exports a single function returning an array of
`{ uid, summary, start (Date), url, cancelled }` sorted by start time.

### `scripts/zol-calendar.js` (new)

Cron `*/15 * * * *` (matches the existing `zol-zabal-watch.js` polling
cadence). This 15-minute poll IS the "instant on add" behavior - the ICS
feed has no push mechanism, and 15 minutes is effectively instant for an
event announcement.

Each run:

1. Fetch + parse the ICS feed.
2. Filter to non-cancelled events starting within `CALENDAR_LOOKAHEAD_DAYS`
   (default 7) of now.
3. Load state from `~/zol/calendar-state.json`:
   ```json
   { "knownUids": ["evt-..."], "drafted": { "evt-...:new": true } }
   ```
   `knownUids` covers every UID ever seen in the feed (not just ones inside
   the lookahead window), so an event that was already known before it
   entered the 7-day window does not re-trigger `new` when it ages in.
4. For each event in the window, determine which **moments** are due this
   cycle (a moment fires at most once per event, tracked by the
   `drafted["<uid>:<moment>"]` key):
   - `new` - UID not in `knownUids` yet (first time this event has been
     seen at all, within or outside the window).
   - `day-before` - 20-28 hours before start (wide enough that a missed
     poll cycle still catches it once).
   - `morning-of` - 0-12 hours before start.
5. **Cluster guard**: if more than one moment is due for the same event in
   the same cycle (e.g. an event is added to the calendar only 18 hours
   before it starts, so `new` and `day-before` - or all three - become due
   simultaneously), collapse them into a single cast. Priority order for
   which moment's framing to draft: `morning-of` > `day-before` > `new`
   (most time-urgent framing wins). Mark ALL the due-this-cycle moments as
   drafted in state, not just the one used for framing, so the others never
   fire separately later.
6. For the one moment to actually draft (per event, per cycle): call
   `zol-lib.js`'s `ork()` with a system prompt built from `persona.md` +
   event facts (name, start time, Luma URL) + the moment's framing (brand
   new announcement / reminder - one day out / reminder - happening today).
   Rules: name the specific event, include the Luma link, max 280 chars,
   end on a complete sentence, no emojis, no em dashes, no hashtags, no
   @mentions.
7. Stage the draft to `~/zol/drafts/event-<uid>-<moment>.json`:
   ```json
   { "kind": "event", "uid": "...", "moment": "day-before", "text": "...", "eventUrl": "...", "summary": "...", "start": "..." }
   ```
8. Ping Zaal on Telegram (same pattern as `zol-reply.js`): event name, cast
   text, and the approve command:
   `ssh zaal@ansuz "cd ~/zol/farcaster-agent && node scripts/post-event.js event-<uid>-<moment>"`.
9. Persist state (`knownUids` + `drafted`) at the end of the run, even if
   some individual events failed to draft (state updates are per-event, not
   all-or-nothing).

`ZOL_DRY=1` skips staging/pinging and just logs what would be drafted, same
convention as `zol-daily.js` / `zol-follow.js`.

### `scripts/post-event.js <id>` (new)

Approval-gated publish step for a staged event draft, mirroring
`post-reply.js` but for an **original** cast (no `parentCastId`):

- Read `~/zol/drafts/<id>.json`.
- `zol-lib.js`'s `post({ text, embedUrl: eventUrl, parentUrl: 'https://farcaster.xyz/~/channel/zao' })`.
- Rename the draft file to `<id>.json.posted` on success.

### `dashboard.js` (small edit)

Drafts with `kind === "event"` render in their own "Upcoming events"
section (separate from the existing reply-drafts list). The Post button's
form action dispatches to `post-event.js` when `kind === "event"`, otherwise
`post-reply.js` as today. No other behavior changes.

### `.env.example` (addition)

- `CALENDAR_ICS_URL` - override for the ZAO Luma ICS feed URL. Default (the
  confirmed URL above) lives in code, not required to be set.
- `CALENDAR_LOOKAHEAD_DAYS` - override for the 7-day window.

### `docs/SCRIPTS.md` (addition)

Entries for `zol-calendar.js` and `post-event.js`, same format as existing
entries.

## Gating (hard rule, unchanged)

Every event cast is a draft. Nothing posts without Zaal running
`post-event.js` (via Telegram approval, same as `zol-reply.js`'s model).
No auto-post carve-out for events in this iteration - the existing
`zol-daily` / `zol-follow` auto-post exceptions are untouched and unrelated.

## Explicitly Out of Scope

Farcaster DM auto-reply (Zaal DMing @zolbot on Farcaster and getting a
reply) is a separate, later feature - queued as a follow-up PR, not part of
this change. No DM handling exists anywhere in this repo today; this PR
does not add any.

## Error Handling

- ICS fetch/parse failure: log + Telegram-ping the error, skip the run,
  state file untouched (nothing lost, retried next cycle).
- A single malformed VEVENT block is skipped individually; does not fail
  the whole run.
- `post-event.js` failures (hub rejects the cast, etc.) print the error and
  exit non-zero, same as `post-reply.js` today; the draft file is left in
  place (not renamed to `.posted`) so it can be retried.

## Testing

- `npm run check` - syntax check across all scripts (existing).
- `scripts/secret-scan.sh --all` before every commit (existing).
- `ZOL_DRY=1 node scripts/zol-calendar.js` - dry run against the live ICS
  feed, verify parsing + moment logic without staging or pinging.
- Manual: stage a draft, run `post-event.js` by hand against a disposable
  test cast to confirm the original-cast (no parentCastId) posting path
  works before relying on it for a real event.

## PR / Deploy Notes

PR-only, never pushes to `main` directly. PR description documents the Pi
cron line to add after merge (same convention as the zol-follow PR):

```
*/15 * * * *  cd ~/zol/farcaster-agent && node scripts/zol-calendar.js
```

Secrets (Neynar, OpenRouter, Telegram) are read from the same
`~/.zao/private/*` files every other script already uses - nothing new to
provision.
