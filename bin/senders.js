#!/usr/bin/env node
'use strict';
// Lists the open_ids (never names) of recent senders, newest first, so the owner's id can be found:
// message the bot yourself, run ./senders.sh, and copy your open_id into OWNER_ID in .env.
//   ./senders.sh            table: open_id, last chat type, message count, first seen, last seen
//   ./senders.sh --json     the raw JSON
const C = require('../src/config');
const F = require('../src/files');

let cfg;
try { cfg = C.loadConfig({ requireWebhook: false, requireApp: false }); } catch (e) { console.log('ERROR CONFIG'); console.error(e.message); process.exit(2); }
const P = C.paths(cfg);
const all = F.readJson(P.senders, {}) || {};
const rows = Object.entries(all).reverse();
if (process.argv.includes('--json')) { console.log(JSON.stringify(Object.fromEntries(rows), null, 2)); process.exit(0); }
if (!rows.length) { console.log('no senders recorded yet: send the bot a direct message, then run this again'); process.exit(0); }
console.log('open_id\tchat_type\tcount\tfirst_seen\tlast_seen');
for (const [id, s] of rows) console.log(`${id}\t${s.last_chat_type || ''}\t${s.count || 0}\t${s.first_seen || ''}\t${s.last_seen || ''}`);
const owner = cfg.ownerId || C.ownerStore(P).get();
console.log(owner ? `owner: ${owner}` : 'owner: not set (OWNER_ID is empty)');
