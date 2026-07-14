// post-event.js <id> - publish a staged event draft as an original cast (no
// parent - this is not a reply). Approval-gated: only runs when Zaal invokes
// it, same model as post-reply.js. Run from ~/zol/farcaster-agent.
const fs = require('fs');
const L = require('../src/zol-lib');
const H = process.env.HOME;
const ZAO_CHANNEL = 'https://farcaster.xyz/~/channel/zao';

(async () => {
  const id = process.argv[2];
  if (!id) { console.log('usage: node post-event.js <draftId>'); process.exit(1); }
  const dp = H + '/zol/drafts/' + id + '.json';
  if (!fs.existsSync(dp)) { console.log('no staged draft for ' + id); process.exit(1); }
  let d;
  try {
    d = JSON.parse(fs.readFileSync(dp, 'utf8'));
  } catch (e) {
    console.log('ERR draft ' + id + ' corrupted: ' + e.message);
    process.exit(1);
  }
  await L.post({ text: d.text, embedUrl: d.eventUrl || undefined, parentUrl: ZAO_CHANNEL });
  fs.renameSync(dp, dp + '.posted');
  console.log('POSTED event cast for ' + id);
})().catch((e) => { console.log('ERR ' + ((e && e.message) || e).toString().slice(0, 200)); process.exit(1); });
