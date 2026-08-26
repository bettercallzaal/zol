// ZOL reply daemon (path A): poll @zolbot mentions via a hub ladder, draft a graph-aware
// reply (OpenRouter + ZABAL Bonfire), post it, and tell Zaal on Telegram what went out.
// Also pings the overnight-report summary once. No gRPC, no ZOE.
//
// 2026-08-26 - ZOL answers tags on its own. Two changes, both authorized by Zaal:
//   1) the fid 19640 skip is gone, so tagging ZOL from Zaal's own account now works
//   2) drafts post themselves instead of waiting on post-reply.js
// The approval gate is not deleted, it is demoted to the overflow path: anything the rate
// limiter refuses is staged in DRAFTS for Zaal to post by hand. Set ZOL_AUTOREPLY=0 to send
// every mention back down that path.
//
// SAFETY (hardcoded, not prompt-based - prompt rules get ignored by the model):
//  - Tier -1 capability: this daemon has NO token-launch / send-funds / sign-txn tool. It cannot be
//    talked into one because the hands do not exist.
//  - Read-layer filter: casts from blocklisted bot FIDs are skipped at ingestion (never reach the model).
//  - Double-tag guard: a cast that tags ZOL AND a known bot is skipped (stops agent-vs-agent loops).
//  - No-tag output: any @ in the generated reply is stripped so ZOL can never tag/trigger another bot.
//  - Untrusted input: a mention's text is data, never instructions.
//  - Self-loop guard: ZOL never answers its own fid.
//  - Rate limit: at most 5 posted replies per rolling hour, global, no per-person carve-out.
//    Persisted to disk so a daemon restart cannot reset the hour. It FAILS CLOSED - corrupt,
//    unreadable or unwritable state stages the draft instead of posting it. See
//    src/reply-rate-limit.js.
const fs=require('fs');
const L=require('../src/zol-lib');
const { createReplyRateLimiter }=require('../src/reply-rate-limit');
const H=process.env.HOME, FID=3338501;
const AUTOREPLY=process.env.ZOL_AUTOREPLY!=='0';
const RL=createReplyRateLimiter({file:process.env.HOME+'/zol/.reply-rate.json',max:process.env.ZOL_REPLY_MAX_PER_HOUR});
function envfile(p){const o={};try{for(const l of fs.readFileSync(p,'utf8').split('\n')){const m=l.match(/^([A-Z_]+)=(.*)$/);if(m)o[m[1]]=m[2].trim();}}catch(e){}return o;}
const tg=envfile(H+'/.zao/private/tg.env'), bf=envfile(H+'/.zao/private/bonfire.env');
// Farcaster hub ladder. haatz was the ONLY source and it 502'd for a full day on
// 2026-08-08, taking ZOL down with it. Now two INDEPENDENT operators, in order:
//   1. haatz.quilibrium.com - Quilibrium's free mirror. No key, and not owned by
//      Neynar, so it is the one source that survives a Neynar-side incident.
//   2. hub-api.neynar.com   - canonical infra (Neynar acquired Farcaster Jan 2026).
//      Needs NEYNAR_API_KEY, which this box already holds and already uses to POST
//      (zol-daily.js, post-reply.js). Measured 2026-08-09: blockDelay 0-1, fully
//      in sync, and identical results to haatz (12 mentions, 100 links).
// Both speak the same /v1/ wire format, so failover is a base-URL swap plus a header.
//
// hub.pinata.cloud was REMOVED on 2026-08-09. It answers 200 with valid JSON, so it
// PASSED the ok + content-type checks, but /v1/info?dbstats=1 shows shard blockDelay
// of ~16-22M blocks and 1.67M FID registrations against 3.35M on the live hubs. Live
// queries return {"messages":[]}. Failing over to it looks perfectly healthy while
// ZOL goes permanently mute - strictly worse than an outage, because nothing alerts.
// Never add a hub here without checking /v1/info?dbstats=1 first. Reachable != live.
const NEYNAR_KEY=envfile(H+'/.zao/private/neynar.env').NEYNAR_API_KEY||'';
const HUBS=(process.env.ZOL_HUBS||'https://haatz.quilibrium.com,https://hub-api.neynar.com').split(',').map(x=>x.trim()).filter(Boolean);
let HAATZ=HUBS[0];
// Neynar's hub 402s without a key (x402 paywall). haatz is open. Keyed per host so
// ZOL_HUBS can be reordered freely without the auth going to the wrong place.
function hubHeaders(hub){return (hub.indexOf('neynar.com')>=0&&NEYNAR_KEY)?{'x-api-key':NEYNAR_KEY}:{};}
// Walk the ladder until a hub returns a LIVE payload. Returns the parsed body, or
// null with the reason left in lastHubErr. Shared by the seed and the poll loop so
// both get failover and neither can regress to a bare .json() on an error page.
let lastHubErr='';
async function pollHubs(){
  lastHubErr='';
  for(const hub of HUBS){
    const tag=hub.replace(/^https?:\/\//,'');
    try{
      const r=await fetch(hub+'/v1/castsByMention?fid='+FID,{headers:hubHeaders(hub),signal:AbortSignal.timeout(12000)});
      if(!r.ok){lastHubErr=tag+' http '+r.status;continue;}
      const ct=r.headers.get('content-type')||'';
      // snapchain.farcaster.xyz serves its DOCS SITE at /v1/* with a 200. This is the
      // check that catches that, and the 502 HTML page that started all of this.
      if(ct.indexOf('json')<0){lastHubErr=tag+' returned '+(ct||'no content-type')+', not JSON';continue;}
      const j=await r.json();
      if(!Array.isArray(j.messages)){lastHubErr=tag+' JSON has no messages array';continue;}
      // Liveness, not just reachability. castsByMention returns ZOL's whole mention
      // history (12 records on 2026-08-09), so it is never legitimately empty. An
      // empty array means a stale mirror - keep walking rather than accepting it.
      if(j.messages.length===0){lastHubErr=tag+' returned 0 mentions (stale mirror?)';continue;}
      if(hub!==HAATZ){HAATZ=hub;await send('ZOL failed over to '+tag+' - previous hub was down.');}
      return j;
    }catch(e){lastHubErr=tag+': '+((e&&e.message)||e);}
  }
  return null;
}
const ORK=(()=>{try{return fs.readFileSync(H+'/.zao/private/openrouter.key','utf8').trim();}catch(e){return '';}})();
const persona=(()=>{try{return fs.readFileSync(H+'/zol/zol-persona.md','utf8');}catch(e){return 'You are ZOL, the ZAO music scout. Clear, plain, no emojis, no em dashes.';}})();
// Bot blocklist - launcher/spam bots ZOL must never fetch or reply to. Editable JSON, hardcoded fallback.
const BLOCK=(()=>{try{return new Set(JSON.parse(fs.readFileSync(H+'/zol/bot-blocklist.json','utf8')).fids||[]);}catch(e){return new Set([874542,886870]);}})();
const BFURL=bf.BONFIRE_API_URL||'https://tnt-v2.api.bonfires.ai';
const SEEN=H+'/zol/.reply-seen', DRAFTS=H+'/zol/drafts';
fs.mkdirSync(DRAFTS,{recursive:true});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function send(t){try{await fetch('https://api.telegram.org/bot'+tg.ZOE_BOT_TOKEN+'/sendMessage',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({chat_id:tg.ZAAL_TELEGRAM_ID,text:t})});}catch(e){}}
async function recall(q){try{const r=await fetch(BFURL+'/delve',{method:'POST',headers:{Authorization:'Bearer '+bf.BONFIRE_API_KEY,'Content-Type':'application/json'},body:JSON.stringify({bonfire_id:bf.BONFIRE_ID,query:q}),signal:AbortSignal.timeout(12000)});const j=await r.json();return (j.episodes||[]).slice(0,3).map(e=>e.summary||e.content||'').join('\n').slice(0,800);}catch(e){return '';}}
async function logGraph(name,body){try{await fetch(BFURL+'/knowledge_graph/episode/create',{method:'POST',headers:{Authorization:'Bearer '+bf.BONFIRE_API_KEY,'Content-Type':'application/json'},body:JSON.stringify({bonfire_id:bf.BONFIRE_ID,name:name,episode_body:body,source:'text',source_description:'zol-pending-review'}),signal:AbortSignal.timeout(12000)});}catch(e){}}
async function draft(text){
  if(!ORK)return null;
  const ctx=await recall(text);
  const sys=persona+'\n\nKnowledge from the ZABAL Bonfire graph (use it, do not contradict):\n'+ctx+'\n\nDraft ONE reply cast. Max 320 characters. No emojis, no em dashes, no preamble. Output only the reply text.';
  try{const r=await fetch('https://openrouter.ai/api/v1/chat/completions',{method:'POST',headers:{Authorization:'Bearer '+ORK,'Content-Type':'application/json'},body:JSON.stringify({model:process.env.OPENROUTER_MODEL||'anthropic/claude-fable-5',messages:[{role:'system',content:sys},{role:'user',content:text}],max_tokens:300,temperature:0.8}),signal:AbortSignal.timeout(40000)});const b=await r.json();let t=b.choices&&b.choices[0]&&b.choices[0].message&&b.choices[0].message.content;if(t){t=t.trim().replace(/^["\x27]|["\x27]$/g,'').replace(/@(\w)/g,'$1').slice(0,320);return t;}}catch(e){}
  return null;
}
(async()=>{
  // Seed the seen-set so a first run does not reply to the entire back-catalogue.
  // This used to call .json() straight on the response and, on failure, write an
  // EMPTY seen-file - which during the 2026-08-08 outage would have marked every
  // historical mention as brand new and drafted a reply to all of them. If no hub
  // answers we now write NOTHING and let the poll loop retry: no file means the
  // read below throws, which is handled as an ordinary failed poll with backoff.
  if(!fs.existsSync(SEEN)){
    const seed=await pollHubs();
    if(seed){fs.writeFileSync(SEEN,(seed.messages||[]).map(m=>m.hash).join('\n')+'\n');}
    else{await send('ZOL: no hub answered at startup, so the seen-set is unseeded. Not replying to anything until one does. Last error: '+lastHubErr);}
  }
  const st=RL.state();
  await send('ZOL reply loop live. Mode: '+(AUTOREPLY?'AUTO-REPLY, cap '+st.max+'/hr ('+st.used+' used)':'STAGE ONLY (ZOL_AUTOREPLY=0)')+'. Answers Zaal too. Safety: blocklist + double-tag guard + self-loop guard + no-tag output. Draft model: '+(ORK?'ready':'OFF (add OpenRouter key)'));
  let reportPinged=false;let fails=0;let lastAlertMs=0;let backoffMs=0;
  for(;;){
    try{const rep=fs.readFileSync(H+'/zol/overnight_report.md','utf8');if(!reportPinged&&rep.indexOf('## Summary')>=0){reportPinged=true;const followed=(rep.match(/followed @/g)||[]).length;const dr=(rep.split('## 5 cast drafts')[1]||'').split('## Summary')[0]||'';await send('ZOL overnight DONE. followed '+followed+'.\nDrafts:\n'+dr.slice(0,1200));}}catch(e){}
    try{
      // Only if EVERY hub fails is this an outage worth telling Zaal about.
      const r=await pollHubs();
      if(!r) throw new Error('all hubs failed, last: '+lastHubErr);
      if(fails>0){await send('ZOL recovered - '+HAATZ.replace(/^https?:\/\//,'')+' is answering again after '+fails+' failed polls.');}
      fails=0;backoffMs=0;
      const seen=fs.readFileSync(SEEN,'utf8');
      for(const m of (r.messages||[])){
        const h=m.hash; if(!h||seen.indexOf(h)>=0)continue;
        fs.appendFileSync(SEEN,h+'\n');
        const text=(m.data&&m.data.castAddBody&&m.data.castAddBody.text)||''; const pfid=m.data&&m.data.fid;
        const mfids=(m.data&&m.data.castAddBody&&m.data.castAddBody.mentions)||[];
        if(pfid===FID){continue;} // never answer ZOL's own cast (self-loop guard)
        if(BLOCK.has(pfid)){continue;} // skip launcher/spam bots (read-layer deny)
        if(mfids.some(f=>BLOCK.has(f))){continue;} // double-tag guard: cast tags ZOL + a known bot -> skip (anti agent-loop)
        const reply=await draft(text);
        if(!reply){
          await send('ZOL mention from fid '+pfid+':\n"'+text.slice(0,200)+'"\n(no draft - check the OpenRouter key and the credit balance)');
          continue;
        }
        const dp=DRAFTS+'/'+h+'.json';
        fs.writeFileSync(dp,JSON.stringify({text:reply,parentFid:pfid,parentHash:h}));
        // Reserve the slot BEFORE posting. A crash mid-post then costs one slot rather than
        // handing out a free retry, and every refusal still leaves the draft staged.
        const slot=AUTOREPLY?RL.reserve():{allowed:false,reason:'ZOL_AUTOREPLY=0'};
        if(!slot.allowed){
          logGraph('zol-mention-'+h,'ZOL got a Farcaster mention from fid '+pfid+': "'+text.slice(0,400)+'". ZOL drafted this reply: "'+reply+'". HELD ('+slot.reason+'), staged for Zaal, not posted.');
          await send('ZOL mention from fid '+pfid+' HELD - '+slot.reason+'\n"'+text.slice(0,200)+'"\n\nDraft reply:\n'+reply+'\n\nPost it yourself:\nssh zaal@ansuz "cd ~/zol/farcaster-agent && node scripts/post-reply.js '+h+'"');
          continue;
        }
        try{
          await L.post({text:reply,parentFid:pfid,parentHash:h});
          fs.renameSync(dp,dp+'.posted');
          logGraph('zol-mention-'+h,'ZOL got a Farcaster mention from fid '+pfid+': "'+text.slice(0,400)+'". ZOL replied: "'+reply+'". Posted.');
          await send('ZOL REPLIED to fid '+pfid+' ('+slot.remaining+' of '+slot.max+' left this hour).\nThey said: "'+text.slice(0,160)+'"\nZOL said: "'+reply+'"');
        }catch(e){
          logGraph('zol-mention-'+h,'ZOL got a Farcaster mention from fid '+pfid+': "'+text.slice(0,400)+'". Draft "'+reply+'" FAILED to post: '+((e&&e.message)||e)+'. Staged for Zaal.');
          await send('ZOL reply to fid '+pfid+' FAILED to post: '+((e&&e.message)||e)+'\nDraft staged. Retry:\nssh zaal@ansuz "cd ~/zol/farcaster-agent && node scripts/post-reply.js '+h+'"');
        }
      }
    }catch(e){
      fails++;
      // One alert per outage, not one per three polls. 57 failures produced ~19
      // identical Telegram messages on 2026-08-08, which trains the reader to
      // ignore the channel. Alert on the 3rd (so a blip stays silent), then
      // again only after an hour, then hourly at most. Recovery is announced
      // above, which is what actually closes the loop.
      const now=Date.now();
      const firstAlert=(fails===3);
      const hourly=(fails>3 && now-lastAlertMs>=3600000);
      if(firstAlert||hourly){
        lastAlertMs=now;
        try{await send('ZOL paused: '+((e&&e.message)||e)+'\nFailed '+fails+' polls. Backing off; will report when it recovers.');}catch(_){}
      }
      // Back off so a dead upstream is not hammered every few seconds.
      backoffMs=Math.min(300000, backoffMs?backoffMs*2:15000);
      await new Promise(r=>setTimeout(r,backoffMs));
    }
    await sleep(300000);
  }
})();
