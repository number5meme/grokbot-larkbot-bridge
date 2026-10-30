'use strict';
// Thin wrapper around the official Lark Node SDK client (@larksuiteoapi/node-sdk). Every call goes through the SDK
// (which fetches and caches the tenant_access_token). The wrapper only normalizes errors into LarkError with Lark's
// numeric code and message, and never puts tokens or secrets into errors or logs.
//
// The "client" passed in only needs: request(payload) -> body, tokenManager.getTenantAccessToken() -> string,
// im.v1.messageResource.get(...) -> { getReadableStream() }, im.v1.image.create(...) -> { image_key } and
// im.v1.file.create(...) -> { file_key }. Tests pass a fake with the same shape.

const USER_AGENT = 'grokbot-larkbot-bridge';

// Lark error codes the bridge treats specially (see docs/lark-api.md).
const CODES = {
  NO_SCOPE: 99991672, // app has not been granted a required scope (message lists the scope names)
  NO_USER_SCOPE: 99991679, // user-level scope missing
  TOKEN_INVALID: 99991663,
  TOKEN_MISSING: 99991661,
  APP_ID_INVALID: 10003,
  APP_SECRET_INVALID: 10014,
  CONTACT_RANGE: 40004, // contact: no permission for this department / user (outside the contact data range)
  CONTACT_NO_AUTHORITY: 41050, // contact: no user authority
  BOT_NOT_IN_CHAT: 230002,
  BOT_NO_AVAILABILITY: 230013, // bot has no availability to this user
  CROSS_TENANT: 230038,
  RECEIVER_INVALID: 230001,
};
const CREDENTIAL_CODES = new Set([CODES.APP_ID_INVALID, CODES.APP_SECRET_INVALID]);
const SCOPE_CODES = new Set([CODES.NO_SCOPE, CODES.NO_USER_SCOPE, CODES.CONTACT_RANGE, CODES.CONTACT_NO_AUTHORITY]);

class LarkError extends Error {
  constructor({ label, code = null, msg = '', httpStatus = null, op = '' }) {
    super(`${op ? `${op}: ` : ''}${code !== null ? `code ${code}` : label}${msg ? ` ${msg}` : ''}`);
    Object.assign(this, { label, code, larkMsg: msg, httpStatus, op });
    this.scopeMissing = code !== null && SCOPE_CODES.has(code);
    this.badCredentials = code !== null && CREDENTIAL_CODES.has(code);
  }
}

const SECRETISH = /(Bearer\s+)[A-Za-z0-9._~+/=-]+|\b(t|u|a)-[A-Za-z0-9._-]{20,}/g;
/** Remove anything that looks like a token from a string, and a known secret if given. */
function redact(s, secrets = []) {
  let out = String(s ?? '').replace(SECRETISH, (m, bearer) => (bearer ? `${bearer}[redacted]` : '[redacted]'));
  for (const x of secrets) if (x && x.length >= 6) out = out.split(x).join('[redacted]');
  return out;
}
function oneLine(s, max = 300) { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > max ? `${t.slice(0, max)}...` : t; }

/** Convert whatever the SDK threw or returned into a LarkError. */
function toLarkError(e, op, secrets) {
  if (e instanceof LarkError) return e;
  const body = e && e.response && e.response.data;
  const status = e && e.response && e.response.status;
  if (body && typeof body === 'object' && body.code !== undefined) {
    return new LarkError({ label: 'API_ERROR', code: Number(body.code), msg: oneLine(redact(body.msg || body.message || '', secrets)), httpStatus: status || null, op });
  }
  // Token errors from the SDK are plain Errors whose message includes the response ("code: 10014, msg: ...").
  const m = /code["\s:=]+(\d+)[^]*?msg["\s:=]+"?([^",}]*)/i.exec(String(e && e.message));
  if (m) return new LarkError({ label: 'API_ERROR', code: Number(m[1]), msg: oneLine(redact(m[2], secrets)), op });
  if (status) return new LarkError({ label: 'HTTP_ERROR', msg: `HTTP ${status}`, httpStatus: status, op });
  const net = e && (e.code || e.name);
  return new LarkError({ label: 'NETWORK', msg: oneLine(redact(net ? String(net) : (e && e.message) || 'request failed', secrets), 120), op });
}

function check(body, op, secrets) {
  if (!body || typeof body !== 'object') throw new LarkError({ label: 'BAD_RESPONSE', msg: 'empty or non-JSON response', op });
  if (body.code !== undefined && Number(body.code) !== 0) {
    throw new LarkError({ label: 'API_ERROR', code: Number(body.code), msg: oneLine(redact(body.msg || '', secrets)), op });
  }
  return body.data !== undefined ? body.data : body;
}

/**
 * SDK logger adapter. The SDK sometimes logs whole axios errors (including request bodies with the app secret)
 * or full event payloads at debug level. This adapter only writes short, redacted strings at info level and above,
 * and reports liveness signals (pong, connect) to onSignal.
 */
function makeSdkLogger(logFn, { secrets = [], onSignal = () => {} } = {}) {
  const one = (a, depth = 0) => {
    if (typeof a === 'string') return a;
    if (typeof a === 'number' || typeof a === 'boolean') return String(a);
    if (Array.isArray(a)) return depth > 2 ? '' : a.map((x) => one(x, depth + 1)).filter(Boolean).join(' ');
    if (a && a.response && a.response.data && a.response.data.code !== undefined) return `code ${a.response.data.code} ${a.response.data.msg || ''}`;
    if (a && typeof a.message === 'string') return a.message; // never serialize whole objects (they may hold secrets)
    return '';
  };
  const fmt = (args) => args.map((a) => one(a)).filter(Boolean).join(' ');
  const out = (level) => (...args) => {
    const text = fmt(args);
    if (/receive pong/.test(text)) onSignal('pong');
    else if (/ws connect success|reconnect success|ws client ready/.test(text)) onSignal('connected');
    if (level === 'debug' || level === 'trace') return;
    // The SDK's start-up banner is a localized console hint; replace it with one English line.
    if (/persistent connection only available/.test(text)) { logFn('sdk info: long connection requires "persistent connection" mode in Events & Callbacks'); return; }
    logFn(`sdk ${level}: ${oneLine(redact(text, secrets), 300)}`);
  };
  return { error: out('error'), warn: out('warn'), info: out('info'), debug: out('debug'), trace: out('trace') };
}

/** Create the real SDK client. Loaded lazily so tests never require the SDK unless they want to. */
function createSdkClient(cfg, logFn = () => {}, onSignal) {
  const lark = require('@larksuiteoapi/node-sdk');
  return new lark.Client({ appId: cfg.appId, appSecret: cfg.appSecret, appType: lark.AppType.SelfBuild, domain: cfg.domain,
    loggerLevel: lark.LoggerLevel.warn, logger: makeSdkLogger(logFn, { secrets: [cfg.appSecret], onSignal }), source: USER_AGENT });
}

function createLarkApi({ client, secrets = [] }) {
  const call = async (op, payload) => {
    let body;
    try { body = await client.request(payload); } catch (e) { throw toLarkError(e, op, secrets); }
    return check(body, op, secrets);
  };

  return {
    /** Fetch (or reuse the cached) tenant_access_token. Returns true; the token itself never leaves the SDK. */
    async tenantToken() {
      let t;
      try { t = await client.tokenManager.getTenantAccessToken(); } catch (e) { throw toLarkError(e, 'tenant_access_token', secrets); }
      if (!t) throw new LarkError({ label: 'NO_TOKEN', msg: 'no tenant_access_token returned', op: 'tenant_access_token' });
      return true;
    },

    /** GET /open-apis/bot/v3/info -> { app_name, open_id, activate_status } */
    async botInfo() {
      const body = await (async () => {
        try { return await client.request({ method: 'GET', url: '/open-apis/bot/v3/info' }); } catch (e) { throw toLarkError(e, 'bot/v3/info', secrets); }
      })();
      const d = check(body, 'bot/v3/info', secrets);
      const bot = (body && body.bot) || (d && d.bot) || d || {};
      return { app_name: bot.app_name || '', open_id: bot.open_id || '', activate_status: bot.activate_status };
    },

    /**
     * Send one message. receiveIdType: open_id | chat_id. msgType: text | image | file; content is the content
     * object ({ text } / { image_key } / { file_key }). replyTo: reply under that message instead. Returns message_id.
     */
    async send({ to, receiveIdType, msgType = 'text', content, replyTo, uuid }) {
      const body = { msg_type: msgType, content: JSON.stringify(content), ...(uuid ? { uuid } : {}) };
      const d = replyTo
        ? await call('im/v1/messages reply', { method: 'POST', url: `/open-apis/im/v1/messages/${encodeURIComponent(replyTo)}/reply`, data: body })
        : await call('im/v1/messages create', { method: 'POST', url: '/open-apis/im/v1/messages', params: { receive_id_type: receiveIdType }, data: { receive_id: to, ...body } });
      return d && d.message_id;
    },

    /** Upload an image for sending (image_type "message"). stream: a fs.ReadStream. Returns image_key. */
    async uploadImage(stream) {
      let r;
      try { r = await client.im.v1.image.create({ data: { image_type: 'message', image: stream } }); } catch (e) { throw toLarkError(e, 'im/v1/images', secrets); }
      if (!r || !r.image_key) throw new LarkError({ label: 'UPLOAD_FAILED', msg: 'no image_key returned', op: 'im/v1/images' });
      return r.image_key;
    },

    /** Upload a file for sending. fileType: opus | mp4 | pdf | doc | xls | ppt | stream. Returns file_key. */
    async uploadFile(stream, { fileName, fileType = 'stream' }) {
      let r;
      try { r = await client.im.v1.file.create({ data: { file_type: fileType, file_name: fileName, file: stream } }); } catch (e) { throw toLarkError(e, 'im/v1/files', secrets); }
      if (!r || !r.file_key) throw new LarkError({ label: 'UPLOAD_FAILED', msg: 'no file_key returned', op: 'im/v1/files' });
      return r.file_key;
    },

    /** Readable stream of a message resource (image or file). type: image | file. */
    async downloadResource({ messageId, fileKey, type }) {
      try {
        const r = await client.im.v1.messageResource.get({ path: { message_id: messageId, file_key: fileKey }, params: { type } });
        return { stream: r.getReadableStream(), headers: r.headers || {} };
      } catch (e) { throw toLarkError(e, 'im/v1/messages resources', secrets); }
    },
  };
}

module.exports = { createLarkApi, createSdkClient, makeSdkLogger, LarkError, toLarkError, redact, CODES, USER_AGENT };
