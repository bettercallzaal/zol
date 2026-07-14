// post-reply.js <hash> - publish the staged draft reply for a mention. Approval-gated:
// only runs when Zaal invokes it. FREE: ZOL self-signs the cast (registered signer) and
// submits to the Neynar hub authenticated with the API key - no x402 payment. Run from ~/zol/farcaster-agent.
const fs=require('fs');
const { makeCastAdd, NobleEd25519Signer, FarcasterNetwork, Message, CastType } = require('@farcaster/hub-nodejs');
const HUB='https://hub-api.neynar.com', FID=3338501, H=process.env.HOME;
function loadKey(){
  if(process.env.NEYNAR_API_KEY) return process.env.NEYNAR_API_KEY.trim();
  const p=H+'/.zao/private/neynar.env';
  for(const line of fs.readFileSync(p,'utf8').split('\n')){
    const m=line.match(/^NEYNAR_API_KEY=(.+)$/); if(m) return m[1].trim();
  }
  throw new Error('NEYNAR_API_KEY not found in env or '+p);
}
(async()=>{
  const hash=process.argv[2];
  if(!hash){console.log('usage: node post-reply.js <mentionHash>');process.exit(1);}
  const dp=H+'/zol/drafts/'+hash+'.json';
  if(!fs.existsSync(dp)){console.log('no staged draft for '+hash);process.exit(1);}
  const d=JSON.parse(fs.readFileSync(dp,'utf8'));
  const KEY=loadKey();
  const signerHex=JSON.parse(fs.readFileSync(H+'/.openclaw/farcaster-credentials.json','utf8')).signerPrivateKey;
  const signer=new NobleEd25519Signer(Buffer.from(signerHex,'hex'));
  const add=await makeCastAdd({text:d.text,embeds:[],embedsDeprecated:[],mentions:[],mentionsPositions:[],parentCastId:{fid:d.parentFid,hash:Buffer.from(d.parentHash.replace(/^0x/,''),'hex')},type:CastType.CAST},{fid:FID,network:FarcasterNetwork.MAINNET},signer);
  if(add.isErr())throw new Error('makeCastAdd '+add.error.message);
  const bytes=Message.encode(add.value).finish();
  const res=await fetch(HUB+'/v1/submitMessage',{method:'POST',headers:{'Content-Type':'application/octet-stream','x-api-key':KEY},body:Buffer.from(bytes)});
  if(!res.ok){console.log('hub '+res.status+' '+(await res.text()).slice(0,160));process.exit(1);}
  fs.renameSync(dp,dp+'.posted');
  console.log('POSTED (free via api-key) reply to '+hash);
})().catch(e=>{console.log('ERR '+((e&&e.message)||e).toString().slice(0,200));process.exit(1);});
