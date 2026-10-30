#!/usr/bin/env node
'use strict';
// Live read-only check against the Lark Open Platform. Sends no messages.
//   node bin/verify.js            tenant token and bot info
//   node bin/verify.js --ws 20    also open the long connection (WSClient) for N seconds, then close it
// Prints one line per check. Never prints secrets or tokens. Exit 0 when token and bot info succeed.
const C = require('../src/config');
const F = require('../src/files');
const { createLarkApi, createSdkClient, LarkError } = require('../src/lark-api');

function describe(e) {
  if (e instanceof LarkError) return `${e.code !== null ? `code=${e.code} ` : ''}${e.larkMsg || e.label}`;
  return (e && e.message) || String(e);
}

async function main() {
  let cfg;
  try { cfg = C.loadConfig({ requireWebhook: false }); } catch (e) { console.log('ERROR CONFIG'); console.error(e.message); process.exit(2); }
  const P = C.paths(cfg);
  const log = F.makeLogger(P.log);
  const api = createLarkApi({ client: createSdkClient(cfg, log), secrets: [cfg.appSecret] });
  let ok = true;
  console.log(`domain: ${cfg.domain}`);
  try { await api.tenantToken(); console.log('tenant_access_token: OK'); } catch (e) { ok = false; console.log(`tenant_access_token: FAILED ${describe(e)}`); }
  let bot = null;
  try { bot = await api.botInfo(); console.log(`bot info: OK name=${bot.app_name ? 'present' : 'missing'} open_id=${bot.open_id ? 'present' : 'missing'} activate_status=${bot.activate_status}`); } catch (e) { ok = false; console.log(`bot info: FAILED ${describe(e)}`); }
  const i = process.argv.indexOf('--ws');
  if (i > 0) {
    const secs = Math.min(120, Math.max(5, parseInt(process.argv[i + 1], 10) || 20));
    const { LongConnection } = require('../src/longconn');
    const events = [];
    const conn = new LongConnection({ cfg, logFn: (m) => { log(m); events.push(m); }, onMessage: () => ({}) });
    conn.start();
    await new Promise((r) => setTimeout(r, secs * 1000));
    const st = conn.status();
    conn.stop();
    console.log(`long connection (${secs}s): ${st.everConnected ? 'CONNECTED' : 'NOT CONNECTED'} state=${st.state}${st.fatal ? ` error=${st.fatal}` : ''}${st.lastError ? ` last_error=${st.lastError}` : ''}`);
    if (!st.everConnected) ok = false;
  }
  process.exit(ok ? 0 : 1);
}
main().catch((e) => { console.log('ERROR INTERNAL'); console.error(describe(e)); process.exit(1); });
