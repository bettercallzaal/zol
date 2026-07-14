// ZOL dashboard - status + pending drafts with one-click Post. Serve on the Pi,
// reach it over Tailscale at http://ansuz:8088 (private to your tailnet/LAN).
const http=require('http'), fs=require('fs'), {execFile}=require('child_process'), {URLSearchParams}=require('url');
const H=process.env.HOME, DRAFTS=H+'/zol/drafts', PORT=8088, AGENT=H+'/zol/farcaster-agent';
const esc=s=>String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
function drafts(){try{return fs.readdirSync(DRAFTS).filter(f=>f.endsWith('.json')).map(f=>{const d=JSON.parse(fs.readFileSync(DRAFTS+'/'+f,'utf8'));return{hash:f.replace('.json',''),...d};});}catch(e){return [];}}
function posted(){try{return fs.readdirSync(DRAFTS).filter(f=>f.endsWith('.posted')).length;}catch(e){return 0;}}
function daemonUp(){try{require('child_process').execSync('pgrep -f "node zol-reply.js"');return true;}catch(e){return false;}}
function page(msg){
  const ds=drafts();
  const replyDrafts=ds.filter(d=>d.kind!=='event');
  const eventDrafts=ds.filter(d=>d.kind==='event');
  const rows=replyDrafts.length?replyDrafts.map(d=>`<div class="card"><div class="meta">reply to fid ${esc(d.parentFid)} - ${esc(d.hash).slice(0,14)}...</div><div class="reply">${esc(d.text)}</div><form method="POST" action="/post"><input type="hidden" name="hash" value="${esc(d.hash)}"><button class="post">Post this reply</button> <button class="skip" formaction="/skip">Skip</button></form></div>`).join(''):'<div class="empty">No pending reply drafts. ZOL is quiet - it drafts when @zolbot gets a real mention.</div>';
  const eventRows=eventDrafts.length?eventDrafts.map(d=>`<div class="card"><div class="meta">${esc(d.moment)} - ${esc(d.summary)}</div><div class="reply">${esc(d.text)}</div><form method="POST" action="/post"><input type="hidden" name="hash" value="${esc(d.hash)}"><input type="hidden" name="kind" value="event"><button class="post">Post this event cast</button> <button class="skip" formaction="/skip">Skip</button></form></div>`).join(''):'<div class="empty">No pending event drafts.</div>';
  return `<!doctype html><html><head><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>ZOL</title>
<style>body{background:#0a1628;color:#e6edf3;font:16px -apple-system,system-ui,sans-serif;margin:0;padding:20px;max-width:760px;margin:auto}h1{color:#f5a623;font-size:22px}.status{background:#0f1d33;border:1px solid #1d2d47;border-radius:10px;padding:14px;margin:14px 0;font-size:14px}.status b{color:#f5a623}.card{background:#0f1d33;border:1px solid #1d2d47;border-radius:10px;padding:16px;margin:14px 0}.meta{color:#7d8aa0;font-size:12px;margin-bottom:8px}.reply{font-size:16px;line-height:1.5;white-space:pre-wrap;margin-bottom:14px}button{font:15px system-ui;border:0;border-radius:8px;padding:10px 16px;cursor:pointer}.post{background:#f5a623;color:#0a1628;font-weight:600}.skip{background:#26324a;color:#e6edf3}.empty{color:#7d8aa0;padding:30px;text-align:center}.msg{background:#143d2a;border:1px solid #1f6b45;border-radius:8px;padding:10px;margin:10px 0;color:#7ee2a8}a{color:#f5a623}</style></head><body>
<h1>ZOL - @zolbot</h1>
${msg?`<div class=msg>${esc(msg)}</div>`:''}
<div class="status">Daemon: <b>${daemonUp()?'live':'DOWN'}</b> &nbsp;|&nbsp; Pending drafts: <b>${ds.length}</b> &nbsp;|&nbsp; Posted: <b>${posted()}</b><br><a href="https://farcaster.xyz/zolbot" target=_blank>farcaster.xyz/zolbot</a></div>
<h2 style="font-size:16px;color:#7d8aa0">Pending replies</h2>
${rows}
<h2 style="font-size:16px;color:#7d8aa0">Upcoming events</h2>
${eventRows}
<p style="color:#56627a;font-size:12px;margin-top:30px">ZOL drafts graph-aware replies to @zolbot mentions. Review here, post with one tap. Nothing posts on its own.</p>
</body></html>`;
}
function body(req){return new Promise(r=>{let b='';req.on('data',c=>b+=c);req.on('end',()=>r(b));});}
http.createServer(async(req,res)=>{
  if(req.method==='POST'){
    const b=await body(req); const hash=new URLSearchParams(b).get('hash');
    if(req.url==='/skip'){try{fs.renameSync(DRAFTS+'/'+hash+'.json',DRAFTS+'/'+hash+'.skipped');}catch(e){} res.writeHead(303,{Location:'/'});return res.end();}
    if(req.url==='/post'){
      const kind=new URLSearchParams(b).get('kind');
      const script=kind==='event'?'scripts/post-event.js':'scripts/post-reply.js';
      execFile('node',[script,hash],{cwd:AGENT},(err,so,se)=>{
        const ok=/POSTED/.test(so||''); res.writeHead(303,{Location:'/?m='+encodeURIComponent(ok?'Posted '+hash.slice(0,12):'Post failed: '+((se||so||err)+'').slice(0,80))}); res.end();
      });
      return;
    }
  }
  const m=new URLSearchParams((req.url.split('?')[1]||'')).get('m');
  res.writeHead(200,{'Content-Type':'text/html'}); res.end(page(m));
}).listen(PORT,'0.0.0.0',()=>console.log('ZOL dashboard on :'+PORT));
