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
