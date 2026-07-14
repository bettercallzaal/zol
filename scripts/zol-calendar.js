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
