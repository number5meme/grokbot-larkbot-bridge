#!/usr/bin/env node
'use strict';
// Lark bot long connection (official SDK WSClient) -> webhook forwarder. Outbound HTTPS/WSS only: no port is opened.
// Usage: node bin/bridge.js            run in the foreground (start.sh runs it in the background)
//        node bin/bridge.js --check    validate configuration, then exit
// Exit codes: 0 stopped, 1 crash, 2 configuration / already running, 16 BAD_CREDENTIALS, 19 LONG_CONNECTION_REJECTED.
const fs = require('node:fs');
const C = require('../src/config');
const F = require('../src/files');
const { createGuard } = require('../src/guard');
const { postWebhook } = require('../src/webhook');
const { makeLarkHandler } = require('../src/handler');
const { createSerialQueue } = require('../src/queue');
const { createMediaStore } = require('../src/media-store');
const { fetchLarkMedia } = require('../src/media');
const { createLarkApi, createSdkClient, USER_AGENT } = require('../src/lark-api');
const { LongConnection } = require('../src/longconn');

const STOP_GRACE_MS = Number(process.env.BRIDGE_STOP_GRACE_MS) || 10_000;
const QUEUE_MAX = 100;

async function main() {
  let cfg;
  try { cfg = C.loadConfig(); } catch (e) {
    if (e instanceof C.ConfigError) { console.error(`ERROR ${e.message}`); process.exit(C.EXIT.CONFIG); }
    throw e;
  }
  if (process.argv.includes('--check')) {
    console.log(`config OK (owner protection ${cfg.protection ? 'on' : 'off'}, mirror ${cfg.mirror}, media ${cfg.acceptMedia ? 'on' : 'off'}, domain ${cfg.domain})`);
    process.exit(0);
  }
  const P = C.paths(cfg);
  F.ensureDir(cfg.stateDir); F.ensureDir(cfg.logDir);
  const log = F.makeLogger(P.log, { echo: process.env.BRIDGE_LOG_STDERR === '1' });
  const setStatus = (s) => { try { F.writeSecure(P.status, s + '\n'); } catch (e) { log(`cannot write STATUS: ${e.code || e.message}`); } };

  const lock = F.acquirePidLock(P.pid);
  if (!lock.ok) { console.error(`ERROR another bridge is already running from this state folder (pid ${lock.pid})`); process.exit(C.EXIT.CONFIG); }
  const removePid = () => { try { if (F.readText(P.pid) === String(process.pid)) fs.unlinkSync(P.pid); } catch { /* ignore */ } };
  process.on('exit', removePid);
  const crash = (what, e) => { log(`crash (${what}): ${e && e.message}`); setStatus('CRASHED'); removePid(); process.exit(C.EXIT.CRASH); };
  process.on('uncaughtException', (e) => crash('uncaught exception', e));
  process.on('unhandledRejection', (e) => crash('unhandled rejection', e));

  let lastBeatWrite = 0;
  const beat = () => { const t = Date.now(); if (t - lastBeatWrite > 10_000) { lastBeatWrite = t; try { F.writeSecure(P.heartbeat, `${t}\n`); } catch { /* ignore */ } } };
  const health = F.readJson(P.health, {}) || {};
  const saveHealth = () => { try { F.writeJson(P.health, health); } catch { /* ignore */ } };
  const fatal = (status, why) => {
    setStatus(status);
    log(`FATAL ${status}: ${why}; not retrying. ${C.FATAL_STATUS[status] || ''}`);
    console.error(`${status}: ${C.FATAL_STATUS[status] || why}`);
    removePid(); process.exit(C.EXIT[status] || C.EXIT.CRASH);
  };

  setStatus('STARTING');
  F.writeSecure(P.heartbeat, `${Date.now()}\n`);
  const api = createLarkApi({ client: createSdkClient(cfg, log), secrets: [cfg.appSecret] });
  // Credentials check and the bot's own open_id (used to strip "@bot" and to detect group mentions).
  let botOpenId = '';
  try { const bot = await api.botInfo(); botOpenId = bot.open_id || ''; log(`bot info ok (open_id ${botOpenId ? 'known' : 'missing'})`); } catch (e) {
    if (e.badCredentials) fatal('BAD_CREDENTIALS', e.message);
    log(`bot info failed (${e.message}); mentions of the bot are detected without its open_id`);
  }

  const guard = createGuard({ protection: cfg.protection, explicitOwner: cfg.ownerId, ownerStore: C.ownerStore(P),
    allowlist: cfg.allowlist, rateLimitPerMin: cfg.rateLimitPerMin, globalRateLimitPerMin: cfg.globalRateLimitPerMin,
    maxChars: cfg.maxMessageChars, logFn: log, statsStore: C.statsStore(P) });
  const forward = (payload) => postWebhook(payload, { url: cfg.webhookUrl, auth: cfg.webhookAuth, logFn: log, userAgent: USER_AGENT });
  let mediaFetch = null;
  if (cfg.acceptMedia) {
    const store = createMediaStore({ dir: cfg.mediaDir, maxBytes: cfg.mediaMaxBytes, retentionDays: cfg.mediaRetentionDays });
    const sweep = () => { const n = store.cleanup(); if (n) log(`media cleanup removed ${n} file(s) older than ${cfg.mediaRetentionDays} day(s)`); };
    sweep(); setInterval(sweep, 60 * 60_000).unref();
    mediaFetch = (messageId, resources) => fetchLarkMedia(messageId, resources, { api, store });
  }
  const handler = makeLarkHandler({ store: C.fileStore(P), guard, forward, mirror: cfg.mirror, logFn: log, fetchMedia: mediaFetch,
    getBotOpenId: () => botOpenId, groupRequireMention: cfg.groupRequireMention });
  // One message at a time, in order: bounded memory for media downloads and ordered webhook calls.
  const queue = createSerialQueue({ worker: handler, maxPending: QUEUE_MAX,
    onOverflow: () => { guard.recordOverload(); log(`drop message: processing queue full (${QUEUE_MAX} waiting)`); },
    onError: (e) => log(`message handler error: ${e && e.message}`) });

  const conn = new LongConnection({ cfg, logFn: (m) => {
    log(m);
    if (/^(long connection error|watchdog|clock jump)/.test(m)) { health.last_error = m.slice(0, 160); health.last_error_at = new Date().toISOString(); saveHealth(); }
  },
  onMessage: (ev) => { queue.push(ev); }, onAlive: beat, onState: (s) => setStatus(s),
  onWake: (reason, driftMs) => { health.last_wake_at = new Date().toISOString(); health.last_wake_drift_ms = Math.max(0, Math.round(driftMs || 0)); saveHealth(); },
  onFatal: (status, why) => fatal(status, why) });

  // Graceful stop: stop receiving, give queued and in-flight messages up to STOP_GRACE_MS, then write anything
  // unfinished to undelivered.jsonl (flagged "interrupted") so it can be replayed.
  let stopping = false;
  const stop = async (sig) => {
    if (stopping) return; stopping = true;
    log(`received ${sig}, stopping`);
    conn.stop(); queue.close();
    const drained = await queue.drain(STOP_GRACE_MS);
    if (!drained) {
      const { waiting } = queue.takeUnfinished();
      const n = handler.salvage(waiting);
      log(`stop: ${n} unfinished message(s) written to undelivered.jsonl (interrupted)`);
    }
    setStatus('STOPPED'); removePid(); process.exit(0);
  };
  process.on('SIGTERM', () => { stop('SIGTERM'); });
  process.on('SIGINT', () => { stop('SIGINT'); });

  log(`bridge started pid=${process.pid} protection=${cfg.protection ? 'on' : 'off'} mirror=${cfg.mirror} media=${cfg.acceptMedia ? 'on' : 'off'} owner=${guard.owner() ? 'bound' : 'not bound'}`);
  conn.start();
}

main().catch((e) => { console.error(`ERROR ${e && e.message}`); process.exit(1); });
