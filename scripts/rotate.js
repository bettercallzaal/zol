const fs=require('fs');
const { addSigner } = require('../src/add-signer');
const { Wallet, JsonRpcProvider, Contract } = require('ethers');
const { CONTRACTS } = require('../src/config');
// Suppress any line that would print a private key (do NOT leak this time)
const realLog=console.log;
console.log=(...a)=>{const s=a.map(x=>String(x)).join(' ');if(/private key/i.test(s))return;realLog('  '+s);};
(async()=>{
  const custody=fs.readFileSync(process.env.HOME+'/zol/.zol-wallet-key','utf8').trim();
  const credsPath=process.env.HOME+'/.openclaw/farcaster-credentials.json';
  const creds=JSON.parse(fs.readFileSync(credsPath,'utf8'));
  const oldPub=creds.signerPublicKey;
  realLog('rotating. old pubkey: '+oldPub);
  const r=await addSigner(custody);              // adds NEW signer (privkey print suppressed)
  creds.signerPrivateKey=r.signerPrivateKey;     // saved to file, never logged
  creds.signerPublicKey=r.signerPublicKey;
  creds.rotated_at=new Date().toISOString();
  creds.removed_old=oldPub;
  fs.writeFileSync(credsPath,JSON.stringify(creds),{mode:0o600});
  realLog('NEW signer pubkey: '+r.signerPublicKey);
  realLog('add-signer tx: '+r.txHash);
  // remove the OLD (leaked) key so it can no longer cast
  const p=new JsonRpcProvider('https://optimism.drpc.org');
  const w=new Wallet(custody,p);
  const kr=new Contract(CONTRACTS.KEY_REGISTRY,['function remove(bytes calldata key)'],w);
  const rm=await kr.remove('0x'+oldPub);
  realLog('remove-old tx: '+rm.hash);
  const rc=await rm.wait();
  realLog('old leaked key removed. status '+rc.status);
})().catch(e=>realLog('ERR '+((e&&e.message)||e).toString().slice(0,200)));
