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
