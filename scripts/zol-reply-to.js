// zol-reply-to.js <parentFid> <parentHash> "<text>" [embedUrl] - reply into any thread.
const L = require('../src/zol-lib');
(async () => { const [, , pf, ph, body, embed] = process.argv; if (!pf || !ph || !body) { console.log('usage: node zol-reply-to.js <parentFid> <parentHash> "<text>" [embedUrl]'); process.exit(1); } await L.post({ text: body, parentFid: parseInt(pf, 10), parentHash: ph, embedUrl: embed }); console.log('REPLIED: ' + L.clean(body).slice(0, 320)); })().catch(e => { console.error('ERR', e.message || e); process.exit(1); });
