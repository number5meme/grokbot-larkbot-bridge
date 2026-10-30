'use strict';
// Lark bridge configuration and on-disk state layout. Everything comes from environment variables or .env
// (real environment variables win over .env).
const path = require('node:path');
const { loadDotEnv } = require('./env');
const F = require('./files');
const { ConfigError, parseCommon, parseBool, hostAllowed } = require('./config-common');

const ROOT = path.join(__dirname, '..');


// STATUS values that need a human. Supervisors (watchdog.sh, systemd, cron) must not restart on these.
const FATAL_STATUS = {
  BAD_CREDENTIALS: 'app id or app secret rejected by Lark. Fix LARK_APP_ID / LARK_APP_SECRET in .env, then ./start.sh',
  LONG_CONNECTION_REJECTED: 'Lark refused the long connection. In the developer console open Events & Callbacks, choose '
    + '"Receive events through persistent connection", add im.message.receive_v1, publish a new app version, then ./start.sh',
  CONFIG_ERROR: 'configuration is invalid. Fix .env (see .env.example), then ./start.sh',
};
const EXIT = { OK: 0, CRASH: 1, CONFIG: 2, BAD_CREDENTIALS: 16, LONG_CONNECTION_REJECTED: 19 };

// Named domains. Lark international is the default; a full https URL is also accepted (e.g. a test proxy).
const DOMAINS = { lark: 'https://open.larksuite.com', feishu: 'https://open.feishu.cn' };
const ALLOWED_API_HOSTS = ['larksuite.com', 'feishu.cn', 'larkoffice.com'];
const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // Lark image upload limit
const MAX_FILE_BYTES = 30 * 1024 * 1024; // Lark file upload limit

function hostAllowedLocal(hostname, suffixes) { return hostAllowed(hostname, suffixes); }

/** Returns the API base URL for LARK_DOMAIN, or '' when invalid. */
function resolveDomain(v) {
  const s = String(v || 'lark').trim();
  if (DOMAINS[s.toLowerCase()]) return DOMAINS[s.toLowerCase()];
  try {
    const u = new URL(s);
    if (u.protocol !== 'https:' || !hostAllowedLocal(u.hostname, ALLOWED_API_HOSTS)) return '';
    return `${u.protocol}//${u.host}`;
  } catch { return ''; }
}

/**
 * requireWebhook: the bridge needs FORWARD_WEBHOOK_URL and FORWARD_WEBHOOK_AUTH; reply and healthcheck do not.
 * requireApp: everything that talks to Lark needs the app credentials; healthcheck does not.
 */
function loadConfig({ env = process.env, root = ROOT, requireWebhook = true, requireApp = true, dotenv = true } = {}) {
  if (dotenv && env.BRIDGE_NO_DOTENV !== '1') loadDotEnv(path.join(root, '.env'), env);
  const { cfg, errors } = parseCommon(env, { root, requireWebhook });
  if (requireWebhook && cfg.webhookUrl && !cfg.webhookAuth) errors.push('FORWARD_WEBHOOK_AUTH is required (full Authorization header value, e.g. "Bearer <key>")');
  // Lark media limits: images up to 10 MB, files up to 30 MB (MEDIA_MAX_MB still caps inbound downloads).
  cfg.appId = (env.LARK_APP_ID || '').trim();
  cfg.appSecret = (env.LARK_APP_SECRET || '').trim();
  if (requireApp) {
    if (!cfg.appId) errors.push('LARK_APP_ID is required (App ID from the Lark developer console, starts with cli_)');
    else if (!/^cli_[0-9a-fA-F]{16}$/.test(cfg.appId)) errors.push('LARK_APP_ID must look like cli_ followed by 16 hex characters');
    if (!cfg.appSecret) errors.push('LARK_APP_SECRET is required (App Secret from the Lark developer console)');
  }
  cfg.domain = resolveDomain(env.LARK_DOMAIN);
  if (!cfg.domain) errors.push('LARK_DOMAIN must be "lark", "feishu", or an https URL on a Lark/Feishu host');
  const mention = parseBool(env.GROUP_REQUIRE_MENTION, true);
  if (mention === null) errors.push('GROUP_REQUIRE_MENTION must be true or false');
  cfg.groupRequireMention = mention !== false;
  if (errors.length) throw new ConfigError(errors);
  return cfg;
}

function paths(cfg) {
  const s = (f) => path.join(cfg.stateDir, f);
  return {
    seen: s('seen.json'),
    senders: s('senders.json'),
    stats: s('stats.json'),
    status: s('STATUS'),
    heartbeat: s('HEARTBEAT'),
    health: s('health.json'),
    pid: s('bridge.pid'),
    undelivered: s('undelivered.jsonl'),
    owner: s('owner.json'),
    lastSender: s('last-sender.json'),
    replyLock: s('reply.lock'),
    log: path.join(cfg.logDir, 'bridge.log'),
  };
}

const UNDELIVERED_MAX_BYTES = 50 * 1024 * 1024; // undelivered.jsonl is rotated to .1 at this size
const SENDERS_MAX = 200;

function ownerStore(P) {
  return {
    get: () => { const o = F.readJson(P.owner, null); return (o && o.owner_id) || null; },
    set: (id) => F.writeJson(P.owner, { owner_id: id, bound_at: new Date().toISOString() }),
  };
}
function statsStore(P) { return { load: () => F.readJson(P.stats, null), save: (o) => F.writeJson(P.stats, o) }; }

/** File-backed store used by the bridge (all files mode 600). */
function fileStore(P) {
  return {
    loadSeen: () => { const a = F.readJson(P.seen, []); return Array.isArray(a) ? a : []; },
    saveSeen: (arr) => F.writeJson(P.seen, arr),
    saveLastSender: (id) => F.writeJson(P.lastSender, { sender_id: id, at: new Date().toISOString() }),
    getLastSender: () => { const o = F.readJson(P.lastSender, null); return (o && o.sender_id) || null; },
    appendUndelivered: (o) => F.appendSecure(P.undelivered, JSON.stringify(o) + '\n', { maxBytes: UNDELIVERED_MAX_BYTES }),
    /** Remember a sender's open_id (never the name) so the owner can be identified with ./senders.sh. */
    noteSender: (openId, chatType, atIso) => {
      const all = F.readJson(P.senders, {}) || {};
      const prev = all[openId] || { first_seen: atIso, count: 0 };
      delete all[openId];
      all[openId] = { first_seen: prev.first_seen, last_seen: atIso, count: (prev.count || 0) + 1, last_chat_type: chatType };
      const keys = Object.keys(all);
      for (const k of keys.slice(0, Math.max(0, keys.length - SENDERS_MAX))) delete all[k];
      F.writeJson(P.senders, all);
    },
  };
}

module.exports = { ROOT, FATAL_STATUS, EXIT, DOMAINS, ConfigError, loadConfig, paths, ownerStore, statsStore, fileStore, resolveDomain,
  UNDELIVERED_MAX_BYTES, SENDERS_MAX, MAX_IMAGE_BYTES, MAX_FILE_BYTES };
