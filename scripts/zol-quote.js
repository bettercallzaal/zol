// zol-quote.js <quotedFid> <quotedHash> "<text>" - quote-cast a cast with ZOL's thoughts.
const L = require('../src/zol-lib');
(async () => { const [, , f, h, t] = process.argv; if (!f || !h || !t) { console.log('usage: node zol-quote.js <fid> <hash> "<text>"'); process.exit(1); } await L.quoteCast({ text: t, quotedFid: parseInt(f, 10), quotedHash: h }); console.log('QUOTE-CAST posted'); })().catch(e => { console.error('ERR', e.message || e); process.exit(1); });
