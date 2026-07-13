// zol-zabal-watch - Automation 2: engage new /zabal channel casts.
// Polls the channel, replies ONCE to genuinely new top-level casts with a
// short content-specific line, hard anti-spam caps. DRY-RUN unless
// ZABAL_WATCHER_LIVE=1. Logs every action to ~/zol/zabal-watch.log.
const fs = require("fs");
const os = require("os");
const path = require("path");
const L = require('../src/zol-lib');

const HOME = os.homedir();
const STATE = path.join(HOME, "zol/zabal-watch-state.json");
const LOG = path.join(HOME, "zol/zabal-watch.log");
const LIVE = process.env.ZABAL_WATCHER_LIVE === "1";
const ZOLBOT_FID = 3338501, ZAAL_FID = 19640;
const BOT_HINTS = ["bot", "clanker", "paybot", "bracky", "aethernet"];
const DAY_CAP = 6, AUTHOR_COOLDOWN_MS = 12 * 3600 * 1000, MAX_LEN = 200;
const NEYNAR = "https://api.neynar.com";

function log(s){ fs.appendFileSync(LOG, new Date().toISOString()+" "+s+"\n"); }
function loadState(){ try { return JSON.parse(fs.readFileSync(STATE,"utf8")); } catch(e){ return { lastSeen:null, seenAuthors:[], authorLast:{}, day:"", dayCount:0, queue:[] }; } }
function saveState(s){ fs.writeFileSync(STATE, JSON.stringify(s,null,2)); }
function today(){ return new Date().toISOString().slice(0,10); }

function envfile(p){ const o={}; try{ for(const l of fs.readFileSync(p,"utf8").split("\n")){ const m=l.match(/^([A-Z_]+)=(.*)$/); if(m)o[m[1]]=m[2].trim(); } }catch(e){} return o; }
const ORK = (()=>{ try { return fs.readFileSync(HOME+"/.zao/private/openrouter.key","utf8").trim(); } catch(e){ return ""; } })();

const BANNED = /excited|thrilled|amazing/i;
function clean(t){
  return String(t)
    .replace(/[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}]/gu,"") // emoji
    .replace(/#\w+/g,"")        // hashtags
    .replace(/[—–]/g,"-") // em/en dash -> hyphen
    .replace(/[ \t]{2,}/g," ")
    .trim();
}

async function draft(cast, isWelcome){
  const surfaces = "wins page https://zabalgamez.com/wins (a win is anything you count as a win from the first half of the year); submissions https://zabalgamez.com/submissions (WIP drafts can take comments); season quest https://zabalgamez.com/quest";
  const sys = "you are zol, the ZABAL Gamez channel host on farcaster. reply to this cast in a short, specific, human way. VOICE: lowercase casual, no emojis, no hashtags, no em dashes (hyphens only), never use the words excited thrilled or amazing. react to what they ACTUALLY said, never a canned line. "+(isWelcome?"they are new to the channel - open with a genuine welcome. ":"")+"if it genuinely fits, point at ONE surface: "+surfaces+". if nothing fits, just reply warm with no link. under 200 characters. output ONLY the reply text.";
  const r = await fetch("https://openrouter.ai/api/v1/chat/completions",{method:"POST",headers:{Authorization:"Bearer "+ORK,"Content-Type":"application/json"},body:JSON.stringify({model:process.env.OPENROUTER_MODEL||"anthropic/claude-fable-5",messages:[{role:"system",content:sys},{role:"user",content:"their cast:\n"+cast}],max_tokens:120,temperature:0.7}),signal:AbortSignal.timeout(45000)});
  const b = await r.json();
  let t = b.choices && b.choices[0] && b.choices[0].message && b.choices[0].message.content;
  if(!t) return null;
  t = clean(t);
  if(BANNED.test(t)) t = t.replace(BANNED,"good");
  if(t.length > MAX_LEN){
    const um = t.match(/https?:\/\/\S+/);
    if(um){
      const url = um[0];
      let prose = t.slice(0, um.index).trim();
      const budget = MAX_LEN - url.length - 1;
      if(budget < 20){ t = prose.slice(0,MAX_LEN).replace(/\s+\S*$/,""); } // url too long, drop it
      else { if(prose.length > budget) prose = prose.slice(0,budget).replace(/\s+\S*$/,""); t = prose+" "+url; }
    } else {
      t = t.slice(0,MAX_LEN).replace(/\s+\S*$/,"");
    }
  }
  return t;
}

(async ()=>{
  const s = loadState();
  if(s.day !== today()){ s.day = today(); s.dayCount = 0; }
  // fetch channel casts (top-level)
  const feed = await fetch(NEYNAR+"/v2/farcaster/feed/channels?channel_ids=zabal&with_replies=false&limit=25",{headers:{"x-api-key":L.KEY,accept:"application/json"}}).then(r=>r.json()).catch(()=>({}));
  const casts = (feed.casts||[]);
  // newest first from API; process oldest-of-new first
  let fresh = [];
  for(const c of casts){
    if(s.lastSeen && c.hash === s.lastSeen) break;
    fresh.push(c);
  }
  fresh.reverse();
  if(casts[0]) s.lastSeen = casts[0].hash;

  let acted = 0;
  for(const c of fresh){
    const author = c.author||{};
    const fid = author.fid, uname = (author.username||"").toLowerCase();
    if(fid===ZOLBOT_FID || fid===ZAAL_FID) continue;
    if(c.parent_hash) continue;                 // top-level only
    if(BOT_HINTS.some(h=>uname.includes(h))) continue;
    const last = s.authorLast[fid]||0;
    if(Date.now()-last < AUTHOR_COOLDOWN_MS) continue;   // 1 per author / 12h
    if(s.dayCount >= DAY_CAP){ log("DAYCAP hit, skipping @"+uname); break; }
    const isWelcome = !s.seenAuthors.includes(fid);
    let reply;
    try { reply = await draft(c.text||"", isWelcome); } catch(e){ log("DRAFT-ERR "+e.message); continue; }
    if(!reply){ log("NODRAFT @"+uname); continue; }
    const link = "https://farcaster.xyz/"+uname+"/"+String(c.hash).slice(0,10);
    if(LIVE){
      try { await L.post({ text: reply, parentFid: fid, parentHash: c.hash }); }
      catch(e){ log("POST-ERR "+e.message+" @"+uname); continue; }
      log("REPLIED @"+uname+" "+link+(isWelcome?" [welcome]":"")+" :: "+reply);
    } else {
      log("DRYRUN @"+uname+" "+link+(isWelcome?" [welcome]":"")+" :: "+reply);
    }
    if(!s.seenAuthors.includes(fid)) s.seenAuthors.push(fid);
    s.authorLast[fid] = Date.now();
    s.dayCount++; acted++;
  }
  saveState(s);
  log("CYCLE done: "+fresh.length+" new, "+acted+" acted ("+(LIVE?"LIVE":"DRYRUN")+"), dayCount="+s.dayCount);
  console.log("cycle: "+fresh.length+" new, "+acted+" acted, mode="+(LIVE?"LIVE":"DRYRUN"));
})().catch(e=>{ log("FATAL "+e.message); console.error(e.message); process.exit(1); });
