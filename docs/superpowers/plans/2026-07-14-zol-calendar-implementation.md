# ZOL Calendar-Aware Casting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ZOL polls the ZAO Luma calendar every 15 minutes and drafts Telegram-gated Farcaster casts announcing/reminding about upcoming ZAO events, with no new auto-post path.

**Architecture:** Two new pure logic modules (`src/ics-lib.js` for ICS parsing, `src/calendar-moments.js` for due-moment/collapse logic) are unit tested with Node's built-in test runner. A new orchestration script (`scripts/zol-calendar.js`) wires them together with the existing `zol-lib.js` helpers (`ork`, `envfile`) to stage drafts and ping Telegram, following the exact pattern `zol-reply.js` already uses. A new `scripts/post-event.js` publishes an approved draft as an original cast (no parent), mirroring `post-reply.js`. `dashboard.js` gets a small edit to show and route event drafts.

**Tech Stack:** Node.js 20 (already the runtime), Node's built-in `node:test` + `node:assert` for unit tests (zero new deps), `@farcaster/hub-nodejs` (already a dependency, used via `zol-lib.js`).

## Global Constraints

- No new npm dependencies (spec: "no new heavy deps (a tiny ICS parse is fine)").
- PR-only. Never push to `main` directly (spec: "PR-only, never push main").
- Every event cast is a draft; nothing auto-posts (spec: "Outbound stays gated... never uncapped auto-posting").
- No emojis, no em dashes, no hashtags, no @mentions in generated cast text (spec: persona + repo-wide voice rule).
- Secrets never enter the repo; run `scripts/secret-scan.sh --all` before every commit (spec: "Secrets in .env... never commit").
- `CALENDAR_ICS_URL` default is `https://api.lu.ma/ics/get?entity=calendar&id=cal-jPH4al7AMlXzdNN`, overridable via env var.
- `CALENDAR_LOOKAHEAD_DAYS` default is `7`, overridable via env var.
- Farcaster DM auto-reply is explicitly out of scope for this plan (queued separately per spec).

---

## Task 1: ICS parser (`src/ics-lib.js`)

**Files:**
- Create: `src/ics-lib.js`
- Create: `test/ics-lib.test.js`
- Modify: `package.json` (add `"test": "node --test test/"` script)

**Interfaces:**
- Produces: `parseICS(text: string) -> Array<{ uid: string, summary: string, start: Date, url: string|null, cancelled: boolean }>` (sorted ascending by `start`), and `fetchICS(url: string) -> Promise<string>`. Both exported from `src/ics-lib.js`. Later tasks (`scripts/zol-calendar.js`) call these two functions only.

- [ ] **Step 1: Write the failing tests**

Create `test/ics-lib.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseICS } = require('../src/ics-lib');

const SAMPLE_ICS = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//lu.ma//ics//EN
BEGIN:VEVENT
DTSTART:20260706T220000Z
DTEND:20260706T230000Z
DTSTAMP:20260714T115956Z
ORGANIZER;CN="BetterCallZaal":MAILTO:calendar-invite@lu.ma
UID:evt-fractal106@events.lu.ma
SUMMARY:ZAO FRACTAL #106 Week 2
DESCRIPTION:Get up-to-date information at: https://luma.com/cr7jhxrb\\n\\nHo
 sted by BetterCallZaal
LOCATION:https://luma.com/event/evt-fractal106
SEQUENCE:1
STATUS:CONFIRMED
END:VEVENT
BEGIN:VEVENT
DTSTART:20260831T153000Z
DTEND:20260831T170000Z
DTSTAMP:20260714T115956Z
ORGANIZER;CN="BetterCallZaal":MAILTO:calendar-invite@lu.ma
UID:evt-zabalworkshop@events.lu.ma
SUMMARY:ZABAL GAMEZ Workshop w/Ceci Sakura from Unlock Protocol
LOCATION:https://app.unlock-protocol.com/event/zabal-gamez-workshop-w-ceci-sakura-from-unlock-protocol-5
SEQUENCE:1
STATUS:CONFIRMED
END:VEVENT
BEGIN:VEVENT
DTSTART:20260901T120000Z
DTEND:20260901T130000Z
DTSTAMP:20260714T115956Z
UID:evt-cancelledshow@events.lu.ma
SUMMARY:Cancelled Show
LOCATION:https://luma.com/event/evt-cancelledshow
SEQUENCE:2
STATUS:CANCELLED
END:VEVENT
END:VCALENDAR
`;

test('parses non-cancelled VEVENTs with unfolded DESCRIPTION lines', () => {
  const events = parseICS(SAMPLE_ICS);
  assert.equal(events.length, 2);
});

test('extracts uid, summary, url, and start as a UTC Date', () => {
  const events = parseICS(SAMPLE_ICS);
  const fractal = events.find((e) => e.uid === 'evt-fractal106@events.lu.ma');
  assert.ok(fractal);
  assert.equal(fractal.summary, 'ZAO FRACTAL #106 Week 2');
  assert.equal(fractal.url, 'https://luma.com/event/evt-fractal106');
  assert.equal(fractal.start.toISOString(), '2026-07-06T22:00:00.000Z');
  assert.equal(fractal.cancelled, false);
});

test('sorts events ascending by start time', () => {
  const events = parseICS(SAMPLE_ICS);
  assert.equal(events[0].uid, 'evt-fractal106@events.lu.ma');
  assert.equal(events[1].uid, 'evt-zabalworkshop@events.lu.ma');
});

test('skips events with STATUS:CANCELLED', () => {
  const events = parseICS(SAMPLE_ICS);
  assert.ok(!events.some((e) => e.uid === 'evt-cancelledshow@events.lu.ma'));
});

test('skips a malformed VEVENT missing UID instead of throwing', () => {
  const malformed = SAMPLE_ICS.replace('UID:evt-fractal106@events.lu.ma\n', '');
  const events = parseICS(malformed);
  assert.equal(events.length, 1);
  assert.equal(events[0].uid, 'evt-zabalworkshop@events.lu.ma');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/ics-lib.test.js`
Expected: FAIL - `Cannot find module '../src/ics-lib'`

- [ ] **Step 3: Write the implementation**

Create `src/ics-lib.js`:

```js
// ics-lib.js - tiny hand-rolled ICS (RFC 5545) reader. Only the fields ZOL
// needs (UID, SUMMARY, DTSTART, LOCATION, STATUS) - no external dependency.

function unfold(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const out = [];
  for (const line of lines) {
    if (/^[ \t]/.test(line) && out.length) {
      out[out.length - 1] += line.slice(1);
    } else {
      out.push(line);
    }
  }
  return out;
}

function parseDate(value) {
  const m = String(value).match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})Z?)?$/);
  if (!m) return new Date(NaN);
  const [, y, mo, d, h = '00', mi = '00', s = '00'] = m;
  return new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +s));
}

function parseICS(text) {
  const lines = unfold(text);
  const raw = [];
  let cur = null;
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') { cur = {}; continue; }
    if (line === 'END:VEVENT') { if (cur) raw.push(cur); cur = null; continue; }
    if (!cur) continue;
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const key = line.slice(0, idx).split(';')[0];
    cur[key] = line.slice(idx + 1);
  }
  return raw
    .filter((e) => e.UID && e.SUMMARY && e.DTSTART)
    .map((e) => ({
      uid: e.UID,
      summary: e.SUMMARY,
      start: parseDate(e.DTSTART),
      url: e.LOCATION || null,
      cancelled: e.STATUS === 'CANCELLED',
    }))
    .filter((e) => !e.cancelled)
    .sort((a, b) => a.start - b.start);
}

async function fetchICS(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error('ICS fetch failed: ' + res.status);
  return res.text();
}

module.exports = { parseICS, fetchICS, unfold, parseDate };
```

- [ ] **Step 4: Add the test script to package.json**

In `package.json`, replace the `"scripts"` block:

```json
  "scripts": {
    "check": "for f in scripts/*.js src/*.js; do node --check \"$f\" || exit 1; done && echo 'all scripts OK'",
    "daily": "node scripts/zol-daily.js",
    "dashboard": "node scripts/dashboard.js"
  },
```

with:

```json
  "scripts": {
    "check": "for f in scripts/*.js src/*.js; do node --check \"$f\" || exit 1; done && echo 'all scripts OK'",
    "test": "node --test test/",
    "daily": "node scripts/zol-daily.js",
    "dashboard": "node scripts/dashboard.js"
  },
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test`
Expected: PASS - `5 passing` (or similar), 0 failing

- [ ] **Step 6: Commit**

```bash
git add src/ics-lib.js test/ics-lib.test.js package.json
git commit -m "Add ICS calendar parser with unit tests"
```

---

## Task 2: Due-moment + collapse logic (`src/calendar-moments.js`)

**Files:**
- Create: `src/calendar-moments.js`
- Create: `test/calendar-moments.test.js`

**Interfaces:**
- Consumes: an event shape matching Task 1's `parseICS` output: `{ uid: string, start: Date, ... }` (only `uid` and `start` are used).
- Produces: `dueMoments(event, state, now: Date) -> Array<'new'|'day-before'|'morning-of'>` and `pickFramingMoment(moments: Array<string>) -> string|null`, both exported from `src/calendar-moments.js`. `state` shape: `{ knownUids: string[], drafted: { [key: string]: true } }` where `key` is `` `${uid}:${moment}` ``. Task 3 consumes both functions plus this exact `state` shape.

- [ ] **Step 1: Write the failing tests**

Create `test/calendar-moments.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { dueMoments, pickFramingMoment } = require('../src/calendar-moments');

function emptyState() { return { knownUids: [], drafted: {} }; }
function hoursFromNow(now, h) { return new Date(now.getTime() + h * 3600000); }

test('a brand-new event far in the future is only due for "new"', () => {
  const now = new Date('2026-07-14T12:00:00Z');
  const event = { uid: 'evt-1', start: hoursFromNow(now, 72) };
  assert.deepEqual(dueMoments(event, emptyState(), now), ['new']);
});

test('an already-known event far in the future is not due for anything', () => {
  const now = new Date('2026-07-14T12:00:00Z');
  const event = { uid: 'evt-1', start: hoursFromNow(now, 72) };
  const state = { knownUids: ['evt-1'], drafted: {} };
  assert.deepEqual(dueMoments(event, state, now), []);
});

test('an already-known event 24h out is due for "day-before"', () => {
  const now = new Date('2026-07-14T12:00:00Z');
  const event = { uid: 'evt-1', start: hoursFromNow(now, 24) };
  const state = { knownUids: ['evt-1'], drafted: {} };
  assert.deepEqual(dueMoments(event, state, now), ['day-before']);
});

test('"day-before" does not re-fire once already drafted', () => {
  const now = new Date('2026-07-14T12:00:00Z');
  const event = { uid: 'evt-1', start: hoursFromNow(now, 24) };
  const state = { knownUids: ['evt-1'], drafted: { 'evt-1:day-before': true } };
  assert.deepEqual(dueMoments(event, state, now), []);
});

test('an already-known event 6h out is due for "morning-of"', () => {
  const now = new Date('2026-07-14T12:00:00Z');
  const event = { uid: 'evt-1', start: hoursFromNow(now, 6) };
  const state = { knownUids: ['evt-1'], drafted: {} };
  assert.deepEqual(dueMoments(event, state, now), ['morning-of']);
});

test('a gap between windows (18h out, already known) is due for nothing', () => {
  const now = new Date('2026-07-14T12:00:00Z');
  const event = { uid: 'evt-1', start: hoursFromNow(now, 18) };
  const state = { knownUids: ['evt-1'], drafted: {} };
  assert.deepEqual(dueMoments(event, state, now), []);
});

test('a brand-new event 22h out is due for both "new" and "day-before" (cluster)', () => {
  const now = new Date('2026-07-14T12:00:00Z');
  const event = { uid: 'evt-1', start: hoursFromNow(now, 22) };
  assert.deepEqual(dueMoments(event, emptyState(), now), ['new', 'day-before']);
});

test('a brand-new event 5h out is due for both "new" and "morning-of" (cluster)', () => {
  const now = new Date('2026-07-14T12:00:00Z');
  const event = { uid: 'evt-1', start: hoursFromNow(now, 5) };
  assert.deepEqual(dueMoments(event, emptyState(), now), ['new', 'morning-of']);
});

test('pickFramingMoment prefers morning-of over day-before over new', () => {
  assert.equal(pickFramingMoment(['new', 'day-before']), 'day-before');
  assert.equal(pickFramingMoment(['new', 'morning-of']), 'morning-of');
  assert.equal(pickFramingMoment(['new']), 'new');
  assert.equal(pickFramingMoment([]), null);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/calendar-moments.test.js`
Expected: FAIL - `Cannot find module '../src/calendar-moments'`

- [ ] **Step 3: Write the implementation**

Create `src/calendar-moments.js`:

```js
// calendar-moments.js - pure logic for which "moment" (new / day-before /
// morning-of) an event is due for, and the cluster-collapse guard: if more
// than one moment is due in the same poll cycle (e.g. an event was added to
// the calendar less than a day before it starts), only ONE cast gets
// drafted - the most time-urgent framing - and all due moments are marked
// drafted together so the others never fire separately later.
const DAY_BEFORE_MIN_H = 20, DAY_BEFORE_MAX_H = 28;
const MORNING_OF_MIN_H = 0, MORNING_OF_MAX_H = 12;
const PRIORITY = ['morning-of', 'day-before', 'new'];

function hoursUntil(date, now) {
  return (date.getTime() - now.getTime()) / 3600000;
}

function dueMoments(event, state, now) {
  const key = (moment) => event.uid + ':' + moment;
  const h = hoursUntil(event.start, now);
  const due = [];
  if (!state.knownUids.includes(event.uid) && !state.drafted[key('new')]) {
    due.push('new');
  }
  if (h >= DAY_BEFORE_MIN_H && h <= DAY_BEFORE_MAX_H && !state.drafted[key('day-before')]) {
    due.push('day-before');
  }
  if (h >= MORNING_OF_MIN_H && h <= MORNING_OF_MAX_H && !state.drafted[key('morning-of')]) {
    due.push('morning-of');
  }
  return due;
}

function pickFramingMoment(moments) {
  for (const m of PRIORITY) {
    if (moments.includes(m)) return m;
  }
  return null;
}

module.exports = { hoursUntil, dueMoments, pickFramingMoment };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS - all tests from Task 1 and Task 2 passing, 0 failing

- [ ] **Step 5: Commit**

```bash
git add src/calendar-moments.js test/calendar-moments.test.js
git commit -m "Add due-moment and cluster-collapse logic with unit tests"
```

---

## Task 3: Calendar poll + draft script (`scripts/zol-calendar.js`)

**Files:**
- Create: `scripts/zol-calendar.js`
- Modify: `.env.example` (add `CALENDAR_ICS_URL`, `CALENDAR_LOOKAHEAD_DAYS`)
- Modify: `docs/SCRIPTS.md` (add entry under Daemons)

**Interfaces:**
- Consumes: `parseICS`, `fetchICS` from `src/ics-lib.js` (Task 1); `dueMoments`, `pickFramingMoment` from `src/calendar-moments.js` (Task 2); `envfile`, `ork` from `../src/zol-lib` (existing, signatures: `envfile(path: string) -> object`, `ork(system: string, user: string, opts?: { max?: number, temp?: number }) -> Promise<string|null>`).
- Produces: draft files at `~/zol/drafts/event-<uid>-<moment>.json` with shape `{ kind: 'event', uid, moment, text, eventUrl, summary, start }`, consumed by Task 4 (`post-event.js`) and Task 5 (`dashboard.js`).

- [ ] **Step 1: Write the script**

Create `scripts/zol-calendar.js`:

```js
// zol-calendar.js - polls the ZAO Luma calendar (ICS feed, no webhook exists)
// every 15 minutes and drafts a gated Farcaster cast for events entering one
// of three moments: "new" (first time seen within the lookahead window),
// "day-before" (~20-28h out), "morning-of" (0-12h out). Nothing auto-posts -
// every draft goes to ~/zol/drafts/ and pings Zaal on Telegram for approval,
// same gate as zol-reply.js. If more than one moment is due for the same
// event in one cycle (e.g. it was added to the calendar less than a day
// before it starts), only one cast is drafted - see calendar-moments.js.
// Test without staging/pinging: ZOL_DRY=1 node scripts/zol-calendar.js
const fs = require('fs');
const L = require('../src/zol-lib');
const { parseICS, fetchICS } = require('../src/ics-lib');
const { dueMoments, pickFramingMoment } = require('../src/calendar-moments');

const H = process.env.HOME;
const ICS_URL = process.env.CALENDAR_ICS_URL || 'https://api.lu.ma/ics/get?entity=calendar&id=cal-jPH4al7AMlXzdNN';
const LOOKAHEAD_DAYS = parseInt(process.env.CALENDAR_LOOKAHEAD_DAYS || '7');
const STATE_PATH = H + '/zol/calendar-state.json';
const DRAFTS = H + '/zol/drafts';
const DRY = process.env.ZOL_DRY === '1';
const ZAO_CHANNEL = 'https://farcaster.xyz/~/channel/zao';

const tg = L.envfile(H + '/.zao/private/tg.env');
const TG_TOKEN = tg.ZOE_BOT_TOKEN || tg.TG_TOKEN || '';
const TG_CHAT = tg.ZAAL_TELEGRAM_ID || tg.TG_CHAT || '';
const persona = (() => { try { return fs.readFileSync(H + '/zol/zol-persona.md', 'utf8'); } catch (e) { return 'You are ZOL, the ZAO music scout. Clear, plain, no emojis, no em dashes.'; } })();

const MOMENT_FRAMING = {
  new: 'This is a brand new event just added to the ZAO calendar. Announce it.',
  'day-before': 'This event is happening tomorrow. Write a day-before reminder.',
  'morning-of': 'This event is happening today. Write a same-day reminder.',
};

async function ping(msg) {
  if (!TG_TOKEN || !TG_CHAT) return;
  try {
    await fetch('https://api.telegram.org/bot' + TG_TOKEN + '/sendMessage', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_CHAT, text: msg }),
    });
  } catch (e) {}
}

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')); }
  catch (e) { return { knownUids: [], drafted: {} }; }
}
function saveState(state) {
  fs.mkdirSync(H + '/zol', { recursive: true });
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

async function draftCast(event, moment) {
  const sys = persona + '\n\nEvent facts (use ONLY these, do not invent anything):\nName: ' + event.summary
    + '\nWhen (UTC): ' + event.start.toISOString() + '\nLink: ' + (event.url || 'https://luma.com/zao')
    + '\n\n' + MOMENT_FRAMING[moment]
    + ' Include the link. Max 280 characters, always end on a complete sentence. No emojis, no em dashes, no hashtags, no @mentions. Output ONLY the cast text.';
  const text = await L.ork(sys, 'Write the cast.', { max: 220, temp: 0.7 });
  if (!text) return null;
  let out = text.trim().replace(/^["']|["']$/g, '');
  if (out.length > 280) { out = out.slice(0, 280).replace(/\s+\S*$/, ''); if (!/[.!?]$/.test(out)) out = out.replace(/[\s,;:-]+$/, '') + '.'; }
  return out;
}

(async () => {
  try {
    const icsText = await fetchICS(ICS_URL);
    const events = parseICS(icsText);
    const now = new Date();
    const horizonMs = LOOKAHEAD_DAYS * 24 * 3600000;
    const upcoming = events.filter((e) => {
      const ms = e.start.getTime() - now.getTime();
      return ms >= 0 && ms <= horizonMs;
    });

    const state = loadState();
    let drafted = 0;

    for (const event of upcoming) {
      const moments = dueMoments(event, state, now);
      if (moments.length === 0) continue;
      const framing = pickFramingMoment(moments);

      if (DRY) {
        console.log('[DRY] would draft "' + framing + '" for ' + event.summary + ' (collapsing: ' + moments.join(',') + ')');
      } else {
        const text = await draftCast(event, framing);
        if (text) {
          const id = 'event-' + event.uid.replace(/[^a-zA-Z0-9_-]/g, '_') + '-' + framing;
          fs.mkdirSync(DRAFTS, { recursive: true });
          fs.writeFileSync(DRAFTS + '/' + id + '.json', JSON.stringify({
            kind: 'event', uid: event.uid, moment: framing, text,
            eventUrl: event.url, summary: event.summary, start: event.start.toISOString(),
          }, null, 2));
          await ping('ZOL calendar draft (' + framing + '): ' + event.summary + '\n\n' + text
            + '\n\nApprove + post:\nssh zaal@ansuz "cd ~/zol/farcaster-agent && node scripts/post-event.js ' + id + '"');
          drafted++;
        }
      }

      if (!state.knownUids.includes(event.uid)) state.knownUids.push(event.uid);
      for (const m of moments) state.drafted[event.uid + ':' + m] = true;
      if (!DRY) saveState(state);
    }

    if (DRY) console.log('[DRY] cycle done, ' + upcoming.length + ' upcoming events in window');
    else console.log('cycle done: ' + upcoming.length + ' upcoming, ' + drafted + ' drafted');
  } catch (e) {
    await ping('ZOL calendar poll failed: ' + ((e && e.message) || e));
    console.error('ERR', (e && e.message) || e);
    process.exit(1);
  }
})();
```

- [ ] **Step 2: Add env vars to `.env.example`**

In `.env.example`, after the existing `# --- Signer maintenance only...` block, append:

```
# --- ZAO event calendar (Luma ICS feed, no auth) ---
# Override for the ZAO Luma calendar's public ICS URL. Default (baked into
# scripts/zol-calendar.js) is the confirmed live feed for luma.com/zao:
# https://api.lu.ma/ics/get?entity=calendar&id=cal-jPH4al7AMlXzdNN
CALENDAR_ICS_URL=
# How many days out to look for upcoming events (default 7 if unset).
CALENDAR_LOOKAHEAD_DAYS=
```

- [ ] **Step 3: Add an entry to `docs/SCRIPTS.md`**

In `docs/SCRIPTS.md`, under the `## Daemons` section, add a line after the `zol-follow.js` entry:

```
- zol-calendar.js - polls the ZAO Luma ICS feed every 15 min, drafts a gated event cast for each event entering the "new" / "day-before" / "morning-of" moment (collapses to one cast if multiple moments are due at once). State: ~/zol/calendar-state.json. Nothing auto-posts - approve via post-event.js. Dry-run: ZOL_DRY=1.
```

- [ ] **Step 4: Verify syntax**

Run: `node --check scripts/zol-calendar.js`
Expected: no output (exit code 0)

- [ ] **Step 5: Manual dry run against the live feed**

Run: `ZOL_DRY=1 node scripts/zol-calendar.js`
Expected: prints `[DRY] cycle done, N upcoming events in window` (N depends on what's currently on the calendar - 0 is a valid, correct result if nothing is within 7 days). No files written under `~/zol/drafts` or `~/zol/calendar-state.json` because DRY mode returns before `saveState`/`writeFileSync` for drafts.

- [ ] **Step 6: Commit**

```bash
git add scripts/zol-calendar.js .env.example docs/SCRIPTS.md
git commit -m "Add zol-calendar.js: poll ZAO Luma calendar, draft gated event casts"
```

---

## Task 4: Approval-gated publish script (`scripts/post-event.js`)

**Files:**
- Create: `scripts/post-event.js`
- Modify: `docs/SCRIPTS.md` (add entry under `## One-shot`)

**Interfaces:**
- Consumes: draft file shape from Task 3: `{ kind: 'event', uid, moment, text, eventUrl, summary, start }` at `~/zol/drafts/<id>.json`. Consumes `L.post({ text, embedUrl, parentUrl }) -> Promise<string>` from `../src/zol-lib` (existing).
- Produces: renames the draft file to `<id>.json.posted` on success, matching the convention `post-reply.js` already uses (`dp + '.posted'`) so `dashboard.js`'s `posted()` counter (Task 5) counts it the same way.

- [ ] **Step 1: Write the script**

Create `scripts/post-event.js`:

```js
// post-event.js <id> - publish a staged event draft as an original cast (no
// parent - this is not a reply). Approval-gated: only runs when Zaal invokes
// it, same model as post-reply.js. Run from ~/zol/farcaster-agent.
const fs = require('fs');
const L = require('../src/zol-lib');
const H = process.env.HOME;
const ZAO_CHANNEL = 'https://farcaster.xyz/~/channel/zao';

(async () => {
  const id = process.argv[2];
  if (!id) { console.log('usage: node post-event.js <draftId>'); process.exit(1); }
  const dp = H + '/zol/drafts/' + id + '.json';
  if (!fs.existsSync(dp)) { console.log('no staged draft for ' + id); process.exit(1); }
  const d = JSON.parse(fs.readFileSync(dp, 'utf8'));
  await L.post({ text: d.text, embedUrl: d.eventUrl || undefined, parentUrl: ZAO_CHANNEL });
  fs.renameSync(dp, dp + '.posted');
  console.log('POSTED event cast for ' + id);
})().catch((e) => { console.log('ERR ' + ((e && e.message) || e).toString().slice(0, 200)); process.exit(1); });
```

- [ ] **Step 2: Add an entry to `docs/SCRIPTS.md`**

In `docs/SCRIPTS.md`, under `## One-shot (on demand)`, add a line after the `post-reply.js` entry:

```
- post-event.js <id>  (publish a staged event draft as an original cast - kind:"event" drafts from zol-calendar.js)
```

- [ ] **Step 3: Verify syntax**

Run: `node --check scripts/post-event.js`
Expected: no output (exit code 0)

- [ ] **Step 4: Manual structural test (no live posting - no local secrets)**

Run:
```bash
mkdir -p /tmp/zol-post-event-check/zol/drafts
cat > /tmp/zol-post-event-check/zol/drafts/event-test-new.json <<'EOF'
{"kind":"event","uid":"evt-test","moment":"new","text":"Test cast text.","eventUrl":"https://luma.com/zao","summary":"Test Event","start":"2026-07-20T18:00:00.000Z"}
EOF
HOME=/tmp/zol-post-event-check node scripts/post-event.js event-test-new
```
Expected: fails with an error about the missing `~/.openclaw/farcaster-credentials.json` (e.g. `ENOENT`), NOT a `SyntaxError` or `TypeError` about the draft shape - this confirms the draft is read and parsed correctly and the script reaches the real posting call, which only the Pi (with real signer credentials) can complete. Clean up: `rm -rf /tmp/zol-post-event-check`.

- [ ] **Step 5: Commit**

```bash
git add scripts/post-event.js docs/SCRIPTS.md
git commit -m "Add post-event.js: approval-gated publish for staged event casts"
```

---

## Task 5: Dashboard support for event drafts (`scripts/dashboard.js`)

**Files:**
- Modify: `scripts/dashboard.js`

**Interfaces:**
- Consumes: draft file shape from Task 3 (`kind: 'event'` drafts) alongside the existing reply-draft shape (`kind` absent or not `'event'`).
- Produces: no new exports (this is the top-level dashboard script); this is the final task, nothing downstream depends on it.

- [ ] **Step 1: Read current `drafts()` and `page()` to confirm the exact text to change**

`scripts/dashboard.js` currently has (line numbers from the file as of this plan):
- Line 6: `function drafts(){try{return fs.readdirSync(DRAFTS).filter(f=>f.endsWith('.json')).map(f=>{const d=JSON.parse(fs.readFileSync(DRAFTS+'/'+f,'utf8'));return{hash:f.replace('.json',''),...d};});}catch(e){return [];}}`
- Line 11: the `rows` line building reply cards.
- Line 27-31: the `/post` POST handler, which currently always calls `scripts/post-reply.js`.

- [ ] **Step 2: Split drafts into reply/event lists and add an event section**

In `scripts/dashboard.js`, replace line 11 (the single `rows` line) with two blocks - one for replies, one for events. Replace:

```js
  const rows=ds.length?ds.map(d=>`<div class="card"><div class="meta">reply to fid ${esc(d.parentFid)} - ${esc(d.hash).slice(0,14)}...</div><div class="reply">${esc(d.text)}</div><form method="POST" action="/post"><input type="hidden" name="hash" value="${esc(d.hash)}"><button class="post">Post this reply</button> <button class="skip" formaction="/skip">Skip</button></form></div>`).join(''):'<div class="empty">No pending drafts. ZOL is quiet - it drafts when @zolbot gets a real mention.</div>';
```

with:

```js
  const replyDrafts=ds.filter(d=>d.kind!=='event');
  const eventDrafts=ds.filter(d=>d.kind==='event');
  const rows=replyDrafts.length?replyDrafts.map(d=>`<div class="card"><div class="meta">reply to fid ${esc(d.parentFid)} - ${esc(d.hash).slice(0,14)}...</div><div class="reply">${esc(d.text)}</div><form method="POST" action="/post"><input type="hidden" name="hash" value="${esc(d.hash)}"><button class="post">Post this reply</button> <button class="skip" formaction="/skip">Skip</button></form></div>`).join(''):'<div class="empty">No pending reply drafts. ZOL is quiet - it drafts when @zolbot gets a real mention.</div>';
  const eventRows=eventDrafts.length?eventDrafts.map(d=>`<div class="card"><div class="meta">${esc(d.moment)} - ${esc(d.summary)}</div><div class="reply">${esc(d.text)}</div><form method="POST" action="/post"><input type="hidden" name="hash" value="${esc(d.hash)}"><input type="hidden" name="kind" value="event"><button class="post">Post this event cast</button> <button class="skip" formaction="/skip">Skip</button></form></div>`).join(''):'<div class="empty">No pending event drafts.</div>';
```

- [ ] **Step 3: Render the new event section in the page template**

Replace:

```js
<h2 style="font-size:16px;color:#7d8aa0">Pending replies</h2>
${rows}
```

with:

```js
<h2 style="font-size:16px;color:#7d8aa0">Pending replies</h2>
${rows}
<h2 style="font-size:16px;color:#7d8aa0">Upcoming events</h2>
${eventRows}
```

- [ ] **Step 4: Route the `/post` handler by draft kind**

Replace:

```js
    if(req.url==='/post'){
      execFile('node',['scripts/post-reply.js',hash],{cwd:AGENT},(err,so,se)=>{
        const ok=/POSTED/.test(so||''); res.writeHead(303,{Location:'/?m='+encodeURIComponent(ok?'Posted reply '+hash.slice(0,12):'Post failed: '+((se||so||err)+'').slice(0,80))}); res.end();
      });
      return;
    }
```

with:

```js
    if(req.url==='/post'){
      const kind=new URLSearchParams(b).get('kind');
      const script=kind==='event'?'scripts/post-event.js':'scripts/post-reply.js';
      execFile('node',[script,hash],{cwd:AGENT},(err,so,se)=>{
        const ok=/POSTED/.test(so||''); res.writeHead(303,{Location:'/?m='+encodeURIComponent(ok?'Posted '+hash.slice(0,12):'Post failed: '+((se||so||err)+'').slice(0,80))}); res.end();
      });
      return;
    }
```

- [ ] **Step 5: Verify syntax**

Run: `node --check scripts/dashboard.js`
Expected: no output (exit code 0)

- [ ] **Step 6: Manual test with a fake HOME**

Run:
```bash
mkdir -p /tmp/zol-dashboard-check/zol/drafts
cat > /tmp/zol-dashboard-check/zol/drafts/event-test-new.json <<'EOF'
{"kind":"event","uid":"evt-test","moment":"new","text":"Test cast text.","eventUrl":"https://luma.com/zao","summary":"Test Event","start":"2026-07-20T18:00:00.000Z"}
EOF
HOME=/tmp/zol-dashboard-check node scripts/dashboard.js &
sleep 1
curl -s http://localhost:8088/ | grep -E "Upcoming events|Test Event|Post this event cast"
kill %1
rm -rf /tmp/zol-dashboard-check
```
Expected: the `grep` prints three matching lines (`Upcoming events`, the event summary, and the button label), confirming the new section renders.

- [ ] **Step 7: Commit**

```bash
git add scripts/dashboard.js
git commit -m "Show event drafts in dashboard, route posting by draft kind"
```

---

## Task 6: Full verification + PR

**Files:** none new - final integration checks across everything created in Tasks 1-5.

**Interfaces:** none - this task only runs checks and opens the PR.

- [ ] **Step 1: Run the full syntax check**

Run: `npm run check`
Expected: `all scripts OK`

- [ ] **Step 2: Run the full unit test suite**

Run: `npm test`
Expected: all tests from Task 1 and Task 2 pass, 0 failing

- [ ] **Step 3: Run the secret scanner**

Run: `scripts/secret-scan.sh --all`
Expected: no secrets detected (script exits 0)

- [ ] **Step 4: Push the branch**

Run: `git push -u origin feature/zol-calendar`
Expected: branch pushed, no push to `main`

- [ ] **Step 5: Open the PR**

Run:
```bash
gh pr create --title "Add calendar-aware event casting to ZOL" --body "$(cat <<'EOF'
## Summary
- ZOL polls the ZAO Luma calendar (ICS feed) every 15 minutes and drafts a
  Telegram-gated Farcaster cast for events entering a "new" / "day-before" /
  "morning-of" moment, collapsing to one cast if multiple moments are due
  at once (e.g. an event added less than a day before it starts).
- Every draft goes through the existing approval gate - no new auto-post
  path. Approve with `post-event.js <id>`, same model as `post-reply.js`.
- Dashboard shows staged event drafts alongside reply drafts.

## Deploy note (after merge)
Add this cron line on the Pi:
```
*/15 * * * *  cd ~/zol/farcaster-agent && node scripts/zol-calendar.js
```

## Out of scope
Farcaster DM auto-reply is a separate follow-up, not part of this PR.

## Test plan
- [x] `npm run check` - all scripts pass syntax check
- [x] `npm test` - ics-lib and calendar-moments unit tests pass
- [x] `scripts/secret-scan.sh --all` - no secrets
- [x] `ZOL_DRY=1 node scripts/zol-calendar.js` - dry run against the live ICS feed
- [ ] Manual live-post verification on the Pi (requires real signer credentials)
EOF
)"
```
Expected: PR created, URL printed.

- [ ] **Step 6: Mark spec status**

Update `docs/superpowers/specs/2026-07-14-zol-calendar-design.md`'s `Status:` line from `Approved by Zaal, proceeding to implementation.` to `Implemented, PR open.` Commit:

```bash
git add docs/superpowers/specs/2026-07-14-zol-calendar-design.md
git commit -m "Mark calendar-aware ZOL spec as implemented"
git push
```
