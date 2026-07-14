// zol-delete.js <hash...> - remove casts by hash.
const L = require('../src/zol-lib');
(async () => { for (const h of process.argv.slice(2)) { try { await L.remove(h); console.log('removed ' + h); } catch (e) { console.log('FAIL ' + h + ' ' + (e.message || e)); } } })().catch(e => { console.error('ERR', e.message || e); process.exit(1); });
