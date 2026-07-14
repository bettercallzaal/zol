// zol-neynar-learn.js - ZOL deepens its Farcaster knowledge via Neynar cast search.
// Searches ZAO-ecosystem terms + key people, appends signal to neynar-learnings.md.
// Grounding source for the Farcaster wiki entries. No posting; read + learn only.
const fs = require("fs");
const { KEY, H } = require('../src/zol-lib');
const NEYNAR = "https://api.neynar.com";
const TERMS = process.argv.slice(2).length ? process.argv.slice(2)
  : ["The ZAO", "WaveWarZ", "ZABAL Gamez", "thezao.xyz", "COC Concertz"];
async function search(q){
  try{
    const r = await fetch(NEYNAR + "/v2/farcaster/cast/search?limit=5&q=" + encodeURIComponent(q),
      { headers: { "x-api-key": KEY, accept: "application/json" } });
    if(!r.ok) return { q, err: r.status };
    const j = await r.json();
    const casts = (j.result && j.result.casts) || [];
    return { q, casts: casts.map(c => ({ u: c.author && c.author.username, t: (c.text||"").replace(/\n/g," ").slice(0,140), likes: (c.reactions&&c.reactions.likes_count)||0 })) };
  }catch(e){ return { q, err: String(e).slice(0,80) }; }
}
(async () => {
  const out = [];
  for(const t of TERMS){ out.push(await search(t)); }
  let md = "\n## Neynar learning pass " + new Date().toISOString().slice(0,10) + "\n";
  for(const r of out){
    md += "\n### " + r.q + (r.err ? " (err " + r.err + ")" : "") + "\n";
    for(const c of (r.casts||[])) md += "- @" + c.u + " (" + c.likes + "): " + c.t + "\n";
  }
  fs.appendFileSync(H + "/zol/farcaster-agent/neynar-learnings.md", md);
  console.log(md.slice(0, 1200));
})();
