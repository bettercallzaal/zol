// zol-post-tagged.js "<cast>" ["<reply>"] [user] [embedUrl]
// Post a cast (link as embed) + reply tagging a user for feedback. zabalgamez update poster.
const L = require('../src/zol-lib');
(async () => {
  const main = process.argv[2]; const reply = process.argv[3] || 'how did this look? any suggestions for the next ones?';
  const user = process.argv[4] || 'zaal'; const embed = process.argv[5];
  if (!main) { console.log('usage: node zol-post-tagged.js "<cast>" ["<reply>"] [user] [embedUrl]'); process.exit(1); }
  const parent = await L.post({ text: main, embedUrl: embed, parentUrl: process.env.ZOL_CHANNEL_URL || 'https://farcaster.xyz/~/channel/zabal' });
  console.log('POSTED main: ' + L.clean(main).slice(0, 320));
  const fid = await L.resolveFid(user); if (!fid) throw new Error('no fid for @' + String(user).replace(/^@/, ''));
  await L.post({ text: ' ' + reply, mentions: [fid], mentionsPositions: [0], parentFid: L.FID, parentHash: parent });
  console.log('POSTED reply tagging @' + String(user).replace(/^@/, '') + ' (fid ' + fid + ')');
})().catch(e => { console.error('ERR', e.message || e); process.exit(1); });
