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
