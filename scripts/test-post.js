// test-post.js - one-off: prove FREE posting works (ZOL self-signed cast + Neynar API key, no x402).
const fs=require('fs');
const { makeCastAdd, NobleEd25519Signer, FarcasterNetwork, Message, CastType } = require('@farcaster/hub-nodejs');
const HUB='https://hub-api.neynar.com', FID=3338501, H=process.env.HOME;
function loadKey(){
  if(process.env.NEYNAR_API_KEY) return process.env.NEYNAR_API_KEY.trim();
  for(const line of fs.readFileSync(H+'/.zao/private/neynar.env','utf8').split('\n')){
    const m=line.match(/^NEYNAR_API_KEY=(.+)$/); if(m) return m[1].trim();
  }
  throw new Error('no key');
}
(async()=>{
  const KEY=loadKey();
  const signerHex=JSON.parse(fs.readFileSync(H+'/.openclaw/farcaster-credentials.json','utf8')).signerPrivateKey;
  const signer=new NobleEd25519Signer(Buffer.from(signerHex,'hex'));
  const text=process.argv[2]||'gm. posting free now - signed locally, no per-cast fee.';
  const add=await makeCastAdd({text,embeds:[],embedsDeprecated:[],mentions:[],mentionsPositions:[],type:CastType.CAST},{fid:FID,network:FarcasterNetwork.MAINNET},signer);
  if(add.isErr())throw new Error('makeCastAdd '+add.error.message);
  const bytes=Message.encode(add.value).finish();
  const res=await fetch(HUB+'/v1/submitMessage',{method:'POST',headers:{'Content-Type':'application/octet-stream','x-api-key':KEY},body:Buffer.from(bytes)});
  const body=await res.text();
  console.log('status',res.status, body.slice(0,200));
})().catch(e=>{console.log('ERR '+((e&&e.message)||e).toString().slice(0,200));process.exit(1);});
