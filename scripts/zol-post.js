// zol-post.js "<text>" [embedUrl] - one original cast (free).
const L = require('../src/zol-lib');
(async () => { const text = process.argv[2], embed = process.argv[3]; if (!text) { console.log('usage: node zol-post.js "<text>" [embedUrl]'); process.exit(1); } await L.post({ text, embedUrl: embed }); console.log('POSTED: ' + L.clean(text).slice(0, 320)); })().catch(e => { console.error('ERR', e.message || e); process.exit(1); });
