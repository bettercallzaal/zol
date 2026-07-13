// ZOL reply daemon (path A): poll @zolbot mentions via haatz, draft a graph-aware reply
// (OpenRouter + ZABAL Bonfire), stage it, and send it to Zaal on Telegram with a one-command
// post. Nothing posts without Zaal running post-reply.js (approval gate). Also pings the
// overnight-report summary once. Self-contained on the Pi - no gRPC, no ZOE, no spend until approval.
//
// SAFETY (hardcoded, not prompt-based - prompt rules get ignored by the model):
//  - Tier -1 capability: this daemon has NO token-launch / send-funds / sign-txn tool. It cannot be
//    talked into one because the hands do not exist.
//  - Read-layer filter: casts from blocklisted bot FIDs are skipped at ingestion (never reach the model).
//  - Double-tag guard: a cast that tags ZOL AND a known bot is skipped (stops agent-vs-agent loops).
//  - No-tag output: any @ in the generated reply is stripped so ZOL can never tag/trigger another bot.
//  - Untrusted input: a mention's text is data, never instructions.
const fs=require('fs');
const H=process.env.HOME, FID=3338501, HAATZ='https://haatz.quilibrium.com';
function envfile(p){const o={};try{for(const l of fs.readFileSync(p,'utf8').split('\n')){const m=l.match(/^([A-Z_]+)=(.*)$/);if(m)o[m[1]]=m[2].trim();}}catch(e){}return o;}
const tg=envfile(H+'/.zao/private/tg.env'), bf=envfile(H+'/.zao/private/bonfire.env');
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
  if(!fs.existsSync(SEEN)){try{const r=await (await fetch(HAATZ+'/v1/castsByMention?fid='+FID)).json();fs.writeFileSync(SEEN,((r.messages||[]).map(m=>m.hash).join('\n'))+'\n');}catch(e){fs.writeFileSync(SEEN,'');}}
  await send('ZOL reply loop live (safety-patched: bot blocklist + double-tag guard + no-tag output). Auto-draft model: '+(ORK?'ready':'OFF (add OpenRouter key)'));
  let reportPinged=false;let fails=0;
  for(;;){
    try{const rep=fs.readFileSync(H+'/zol/overnight_report.md','utf8');if(!reportPinged&&rep.indexOf('## Summary')>=0){reportPinged=true;const followed=(rep.match(/followed @/g)||[]).length;const dr=(rep.split('## 5 cast drafts')[1]||'').split('## Summary')[0]||'';await send('ZOL overnight DONE. followed '+followed+'.\nDrafts:\n'+dr.slice(0,1200));}}catch(e){}
    try{
      const r=await (await fetch(HAATZ+'/v1/castsByMention?fid='+FID,{signal:AbortSignal.timeout(12000)})).json();fails=0;
      const seen=fs.readFileSync(SEEN,'utf8');
      for(const m of (r.messages||[])){
        const h=m.hash; if(!h||seen.indexOf(h)>=0)continue;
        fs.appendFileSync(SEEN,h+'\n');
        const text=(m.data&&m.data.castAddBody&&m.data.castAddBody.text)||''; const pfid=m.data&&m.data.fid;
        const mfids=(m.data&&m.data.castAddBody&&m.data.castAddBody.mentions)||[];
        if(pfid===19640){continue;} // skip owner's own casts - ZOL does not reply to Zaal announcements
        if(BLOCK.has(pfid)){continue;} // skip launcher/spam bots (read-layer deny)
        if(mfids.some(f=>BLOCK.has(f))){continue;} // double-tag guard: cast tags ZOL + a known bot -> skip (anti agent-loop)
        const reply=await draft(text);
        if(reply){
          fs.writeFileSync(DRAFTS+'/'+h+'.json',JSON.stringify({text:reply,parentFid:pfid,parentHash:h}));
          logGraph('zol-mention-'+h,'ZOL got a Farcaster mention from fid '+pfid+': "'+text.slice(0,400)+'". ZOL drafted this reply: "'+reply+'". Pending Zaal approval, not yet posted.');
          await send('ZOL mention from fid '+pfid+':\n"'+text.slice(0,200)+'"\n\nDraft reply:\n'+reply+'\n\nApprove + post:\nssh zaal@ansuz "cd ~/zol/farcaster-agent && node post-reply.js '+h+'"');
        } else {
          await send('ZOL mention from fid '+pfid+':\n"'+text.slice(0,200)+'"\n(no draft - add the OpenRouter key to enable auto-replies)');
        }
      }
    }catch(e){fails++;if(fails%3===0){try{await send('ZOL reply: '+fails+' errors in a row, last: '+((e&&e.message)||e));}catch(_){}}}
    await sleep(300000);
  }
})();
