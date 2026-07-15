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
