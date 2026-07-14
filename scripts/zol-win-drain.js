// zol-win-drain - Automation 1 consumer. Pops ONE queued community-win from
// zabalgames /api/win-drain and casts it to the /zabal channel. Cron every
// 10 min => the 1-cast-per-10-min rate limit is structural. Inert (quiet exit)
// until ~/.zao/private/zabal-winhook.env has DRAIN_URL + WIN_HOOK_SECRET.
const fs = require("fs");
const os = require("os");
const L = require('../src/zol-lib');
const LOG = os.homedir()+"/zol/zabal-win-drain.log";
function log(s){ fs.appendFileSync(LOG, new Date().toISOString()+" "+s+"\n"); }
function envfile(p){ const o={}; try{ for(const l of fs.readFileSync(p,"utf8").split("\n")){ const m=l.match(/^([A-Z_]+)=(.*)$/); if(m)o[m[1]]=m[2].trim(); } }catch(e){} return o; }

(async ()=>{
  const e = envfile(os.homedir()+"/.zao/private/zabal-winhook.env");
  if(!e.DRAIN_URL || !e.WIN_HOOK_SECRET){ process.exit(0); } // inert until wired
  const u = e.DRAIN_URL + (e.DRAIN_URL.includes("?")?"&":"?") + "token=" + encodeURIComponent(e.WIN_HOOK_SECRET) + "&n=1";
  let items = [];
  try { const r = await fetch(u,{signal:AbortSignal.timeout(8000)}); const b = await r.json(); items = b.items||[]; }
  catch(err){ log("DRAIN-ERR "+err.message); process.exit(0); }
  if(!items.length){ process.exit(0); }
  const text = String(items[0].text||"");
  const handle = (text.match(/@\w+/)||[""])[0];
  const idm = text.match(/id[=\s]+(\d+)/i);
  const subLink = idm ? "https://zabalgamez.com/submissions?id="+idm[1] : "";
  const cast = ["ZM","","new win on the wall:"+(handle?" "+handle:""), subLink, "a win is anything you define as a win from the first half of the year. add yours: https://zabalgamez.com/wins"]
    .filter((l,i)=> !(i===3 && !subLink))  // drop empty submissions line when no id
    .join("\n");
  try { await L.post({ text: cast }); log("CAST "+(handle||"(no handle)")+(idm?" id="+idm[1]:"")); }
  catch(err){ log("POST-ERR "+err.message); }
})().catch(e=>{ log("FATAL "+e.message); });
