'use strict';
// Lark-specific tests: configuration, message parsing, the inbound handler and payload shape, media download,
// SDK error normalization and log redaction, outbound replies, and the long connection supervisor. No network:
// the SDK client, the Lark API and the WebSocket client are faked.
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert');
const C = require('../src/config');
const { extractMessage } = require('../src/message');
const { makeLarkHandler } = require('../src/handler');
const { createGuard, HANDLING_HINT } = require('../src/guard');
const { createMediaStore } = require('../src/media-store');
const { fetchLarkMedia, readCapped } = require('../src/media');
const { createLarkApi, makeSdkLogger, toLarkError, redact, LarkError } = require('../src/lark-api');
const { sendText, sendMedia, loadImage, loadFile, receiveIdType } = require('../src/reply');
const { LongConnection, EVENT } = require('../src/longconn');
const { Backoff } = require('../src/backoff');
const { Readable } = require('node:stream');
const { memStore, memOwner, fakeApi, larkEvent } = require('./fakes');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'grokbot-larkbot-test-'));
test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));
const BOT = 'ou_bot00000000000001';
const OWNER = 'ou_owner000000001';
const STRANGER = 'ou_stranger00000001';
const ENV = { LARK_APP_ID: 'cli_0123456789abcdef', LARK_APP_SECRET: 'sec', FORWARD_WEBHOOK_URL: 'https://hooks.example.com/x', FORWARD_WEBHOOK_AUTH: 'Bearer k' };
const load = (env, opts = {}) => C.loadConfig({ env: { ...env }, root: TMP, dotenv: false, ...opts });
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

/* ---------------- configuration ---------------- */
test('config: Lark defaults, domain, credentials and webhook are required for the bridge', () => {
  const cfg = load(ENV);
  assert.strictEqual(cfg.domain, 'https://open.larksuite.com');
  assert.strictEqual(cfg.protection, false); assert.strictEqual(cfg.groupRequireMention, true); assert.strictEqual(cfg.acceptMedia, true);
  assert.strictEqual(load({ ...ENV, LARK_DOMAIN: 'feishu' }).domain, 'https://open.feishu.cn');
  assert.strictEqual(load({ ...ENV, LARK_DOMAIN: 'https://open.larksuite.com/' }).domain, 'https://open.larksuite.com');
  const bad = (env, re, opts) => assert.throws(() => load(env, opts), (e) => e instanceof C.ConfigError && e.errors.some((x) => re.test(x)), String(re));
  bad({ ...ENV, FORWARD_WEBHOOK_URL: '' }, /FORWARD_WEBHOOK_URL is required/);
  bad({ ...ENV, FORWARD_WEBHOOK_AUTH: '' }, /FORWARD_WEBHOOK_AUTH is required/);
  bad({ ...ENV, LARK_APP_ID: '' }, /LARK_APP_ID is required/);
  bad({ ...ENV, LARK_APP_ID: '12345' }, /cli_/);
  bad({ ...ENV, LARK_APP_SECRET: '' }, /LARK_APP_SECRET is required/);
  bad({ ...ENV, LARK_DOMAIN: 'https://evil.example.com' }, /LARK_DOMAIN/);
  bad({ ...ENV, LARK_DOMAIN: 'http://open.larksuite.com' }, /LARK_DOMAIN/);
  bad({ ...ENV, GROUP_REQUIRE_MENTION: 'maybe' }, /GROUP_REQUIRE_MENTION/);
  // reply / healthcheck do not need the webhook; healthcheck does not need credentials either
  assert.ok(load({ ...ENV, FORWARD_WEBHOOK_URL: '', FORWARD_WEBHOOK_AUTH: '' }, { requireWebhook: false }));
  assert.ok(load({}, { requireWebhook: false, requireApp: false }));
});

/* ---------------- message parsing ---------------- */
test('extractMessage: text, bot mention stripped, other mentions named, @all', () => {
  const mentions = [{ key: '@_user_1', id: { open_id: BOT }, name: 'Bot' }, { key: '@_user_2', id: { open_id: 'ou_x', user_id: 'u2', union_id: 'on_2' }, name: 'Alex' }];
  const r = extractMessage({ message_type: 'text', content: JSON.stringify({ text: '@_user_1 please ask @_user_2 and @_all' }), mentions }, { botOpenId: BOT });
  assert.strictEqual(r.text, 'please ask @Alex and @all'); assert.strictEqual(r.mentionedBot, true);
  const r2 = extractMessage({ message_type: 'text', content: JSON.stringify({ text: '@_user_2 hi' }), mentions: [mentions[1]] }, { botOpenId: BOT });
  assert.strictEqual(r2.mentionedBot, false); assert.strictEqual(r2.text, '@Alex hi');
  // without the bot open_id, an app mention (no user_id / union_id) counts as the bot
  const r3 = extractMessage({ message_type: 'text', content: JSON.stringify({ text: '@_user_1 x' }), mentions }, {});
  assert.strictEqual(r3.mentionedBot, true); assert.strictEqual(r3.text, 'x');
  // @_user_10 is not damaged by @_user_1
  const many = [{ key: '@_user_1', id: { open_id: BOT } }, { key: '@_user_10', id: { open_id: 'ou_y', user_id: 'u' }, name: 'Ten' }];
  assert.strictEqual(extractMessage({ message_type: 'text', content: JSON.stringify({ text: '@_user_1 @_user_10 ok' }), mentions: many }, { botOpenId: BOT }).text, '@Ten ok');
  assert.strictEqual(extractMessage({ message_type: 'text', content: 'not json' }).text, '');
});

test('extractMessage: post (plain and localized), images, files, audio, video, sticker, unknown', () => {
  const post = { title: 'Weekly', content: [[{ tag: 'at', user_id: '@_user_1' }, { tag: 'text', text: ' status ' }, { tag: 'a', text: 'doc', href: 'https://x.example/d' }],
    [{ tag: 'img', image_key: 'img_1' }, { tag: 'emotion', emoji_type: 'SMILE' }], [{ tag: 'code_block', text: 'a=1' }], [{ tag: 'media', file_key: 'file_v' }]] };
  const mentions = [{ key: '@_user_1', id: { open_id: BOT } }];
  const r = extractMessage({ message_type: 'post', content: JSON.stringify(post), mentions }, { botOpenId: BOT });
  assert.strictEqual(r.text, 'Weekly\nstatus doc https://x.example/d\n[SMILE]\na=1');
  assert.deepStrictEqual(r.resources.map((x) => [x.kind, x.key, x.type]), [['image', 'img_1', 'image'], ['video', 'file_v', 'file']]);
  const loc = extractMessage({ message_type: 'post', content: JSON.stringify({ en_us: { title: 'T', content: [[{ tag: 'text', text: 'body' }]] } }) });
  assert.strictEqual(loc.text, 'T\nbody');
  assert.deepStrictEqual(extractMessage({ message_type: 'image', content: '{"image_key":"img_2"}' }).resources, [{ kind: 'image', key: 'img_2', type: 'image' }]);
  assert.deepStrictEqual(extractMessage({ message_type: 'file', content: '{"file_key":"f1","file_name":"a.pdf"}' }).resources, [{ kind: 'file', key: 'f1', type: 'file', filename: 'a.pdf' }]);
  assert.strictEqual(extractMessage({ message_type: 'audio', content: '{"file_key":"f2"}' }).resources[0].kind, 'voice');
  assert.strictEqual(extractMessage({ message_type: 'media', content: '{"file_key":"f3","image_key":"i"}' }).resources[0].kind, 'video');
  assert.strictEqual(extractMessage({ message_type: 'sticker', content: '{"file_key":"s"}' }).text, '[sticker]');
  assert.strictEqual(extractMessage({ message_type: 'share_chat', content: '{}' }).text, '[share_chat]');
});

/* ---------------- handler and payload ---------------- */
function setup({ protection = false, ownerId = '', forwardOk = true, fetchMedia = null, mention = true, mirror = false } = {}) {
  const store = memStore(); const sent = []; const logs = [];
  const guard = createGuard({ protection, explicitOwner: ownerId, ownerStore: memOwner(), rateLimitPerMin: 20, maxChars: 10 });
  const handler = makeLarkHandler({ store, guard, forward: async (p) => { sent.push(p); return forwardOk; }, mirror, logFn: (m) => logs.push(m),
    now: () => Date.parse('2026-01-02T03:04:05Z'), fetchMedia, getBotOpenId: () => BOT, groupRequireMention: mention });
  return { store, sent, logs, handler };
}

test('handler: payload has exactly the common bridge fields plus chat_id and chat_type', async () => {
  const { sent, handler, store, logs } = setup();
  assert.strictEqual(await handler(larkEvent({ content: { text: 'hi there' } })), 'forwarded');
  assert.deepStrictEqual(sent[0], { source: 'lark', sender_id: OWNER, message_id: 'om_aaaaaaaaaaaa1', chat_id: 'oc_chat0000000001', chat_type: 'p2p',
    text: 'hi there', truncated: false, received_at: '2026-01-02T03:04:05.000Z', untrusted: false, mirror: false });
  assert.strictEqual(store.lastSender, OWNER);
  assert.ok(store.senders[OWNER], 'sender open_id recorded for ./senders.sh');
  assert.ok(logs.some((l) => l === `sender open_id=${OWNER} chat_type=p2p`));
  assert.ok(!JSON.stringify(logs).includes('verification-token'), 'the event token is never logged');
});

test('handler: dedupe by message_id and event_id; non-user senders, group without @bot, empty messages', async () => {
  const { sent, handler } = setup();
  assert.strictEqual(await handler(larkEvent()), 'forwarded');
  assert.strictEqual(await handler(larkEvent()), 'duplicate');
  assert.strictEqual(await handler(larkEvent({ id: 'om_other00000001' })), 'duplicate', 'same event_id redelivered');
  assert.strictEqual(await handler(larkEvent({ id: 'om_bbbbbbbbbbbb2', eventId: 'ev2', senderType: 'app' })), 'not_user');
  assert.strictEqual(await handler(larkEvent({ id: 'om_cccccccccccc3', eventId: 'ev3', chatType: 'group', content: { text: 'chatter' } })), 'not_mentioned');
  const g = await handler(larkEvent({ id: 'om_dddddddddddd4', eventId: 'ev4', chatType: 'group', content: { text: '@_user_1 do it' }, mentions: [{ key: '@_user_1', id: { open_id: BOT }, name: 'Bot' }] }));
  assert.strictEqual(g, 'forwarded');
  assert.strictEqual(sent.at(-1).text, 'do it'); assert.strictEqual(sent.at(-1).chat_type, 'group');
  assert.strictEqual(await handler(larkEvent({ id: 'om_eeeeeeeeeeee5', eventId: 'ev5', type: 'image', content: { image_key: 'k' } })), 'non_text', 'media off');
  assert.strictEqual(await handler({}), 'invalid');
  const open = setup({ mention: false });
  assert.strictEqual(await open.handler(larkEvent({ chatType: 'group', content: { text: 'all messages' } })), 'forwarded');
});

test('handler: owner protection, truncation, untrusted flag and handling hint', async () => {
  const { sent, handler } = setup({ protection: true, ownerId: OWNER });
  assert.strictEqual(await handler(larkEvent({ content: { text: '0123456789abcdef' } })), 'forwarded');
  assert.strictEqual(sent[0].truncated, true); assert.strictEqual(sent[0].text, '0123456789');
  assert.strictEqual(sent[0].untrusted, true); assert.strictEqual(sent[0].handling_hint, HANDLING_HINT);
  assert.strictEqual(await handler(larkEvent({ id: 'om_zzzzzzzzzzzz9', eventId: 'ev9', sender: STRANGER })), 'dropped');
  assert.strictEqual(sent.length, 1);
});

test('handler: undelivered payloads are kept; salvage writes interrupted ones', async () => {
  const { store, handler } = setup({ forwardOk: false });
  assert.strictEqual(await handler(larkEvent()), 'undelivered');
  assert.strictEqual(store.undelivered[0].source, 'lark');
  const n = handler.salvage([larkEvent({ id: 'om_qqqqqqqqqqq10', eventId: 'ev10' }), larkEvent({ id: 'om_qqqqqqqqqqq10', eventId: 'ev10' })]);
  assert.strictEqual(n, 1); assert.strictEqual(store.undelivered[1].interrupted, true);
});

test('handler + media: resources downloaded through the API and listed in "media"; failures keep the message', async () => {
  const store = createMediaStore({ dir: path.join(TMP, 'media'), maxBytes: 1024 });
  const err = new LarkError({ label: 'API_ERROR', code: 234003, msg: 'file not found' });
  const api = fakeApi({ resources: { img_ok: PNG, f_bad: err, f_big: Buffer.alloc(2048) } });
  const { sent, handler } = setup({ fetchMedia: (id, res) => fetchLarkMedia(id, res, { api, store }) });
  const post = { content: [[{ tag: 'text', text: 'see' }, { tag: 'img', image_key: 'img_ok' }]] };
  assert.strictEqual(await handler(larkEvent({ type: 'post', content: post })), 'forwarded');
  const m = sent[0].media;
  assert.strictEqual(m.length, 1); assert.strictEqual(m[0].kind, 'image'); assert.strictEqual(m[0].content_type, 'image/png');
  assert.ok(fs.existsSync(m[0].path)); assert.strictEqual(fs.statSync(m[0].path).mode & 0o777, 0o600);
  assert.deepStrictEqual(api.calls[0], { op: 'download', messageId: 'om_aaaaaaaaaaaa1', fileKey: 'img_ok', type: 'image' });
  assert.strictEqual(await handler(larkEvent({ id: 'om_fffffffffff11', eventId: 'e11', type: 'file', content: { file_key: 'f_bad', file_name: 'x.pdf' } })), 'forwarded');
  assert.deepStrictEqual(sent[1].media, [{ kind: 'file', path: null, error: 'LARK_234003', filename: 'x.pdf' }]);
  assert.strictEqual(await handler(larkEvent({ id: 'om_fffffffffff12', eventId: 'e12', type: 'file', content: { file_key: 'f_big' } })), 'forwarded');
  assert.strictEqual(sent[2].media[0].error, 'TOO_LARGE');
  await assert.rejects(readCapped(Readable.from([Buffer.alloc(10), Buffer.alloc(10)]), 15), (e) => e.label === 'TOO_LARGE');
});

/* ---------------- SDK wrapper: errors, redaction ---------------- */
test('lark-api: HTTP error bodies, token errors and non-zero codes become LarkError with code and message', async () => {
  const httpErr = Object.assign(new Error('Request failed with status code 400'), { response: { status: 400, data: { code: 99991672, msg: 'Access denied. One of the following scopes is required: [im:message:send_as_bot]' } } });
  const client = {
    request: async (p) => { if (p.url.includes('bot/v3')) return { code: 0, bot: { app_name: 'B', open_id: BOT, activate_status: 2 } }; throw httpErr; },
    tokenManager: { getTenantAccessToken: async () => { throw new Error('failed to get tenant_access_token, code: 10014, msg: app secret invalid'); } },
  };
  const api = createLarkApi({ client });
  assert.deepStrictEqual(await api.botInfo(), { app_name: 'B', open_id: BOT, activate_status: 2 });
  await assert.rejects(api.send({ to: OWNER, receiveIdType: 'open_id', content: { text: 'x' } }), (e) => e instanceof LarkError && e.code === 99991672 && e.scopeMissing && /send_as_bot/.test(e.larkMsg));
  await assert.rejects(api.tenantToken(), (e) => e.code === 10014 && e.badCredentials);
  const zero = createLarkApi({ client: { request: async () => ({ code: 230002, msg: 'Bot is not in the chat' }) } });
  await assert.rejects(zero.send({ to: 'oc_x', receiveIdType: 'chat_id', content: { text: 'x' } }), (e) => e.code === 230002);
  assert.strictEqual(toLarkError(Object.assign(new Error('x'), { code: 'ECONNRESET' }), 'op').label, 'NETWORK');
});

test('redaction: tokens and the secret never reach the log; SDK objects are not serialized', () => {
  assert.strictEqual(redact('Authorization: Bearer t-abcdefghijklmnopqrstuvwxyz0123'), 'Authorization: Bearer [redacted]');
  assert.strictEqual(redact('x my-app-secret-value y', ['my-app-secret-value']), 'x [redacted] y');
  const lines = [];
  const lg = makeSdkLogger((m) => lines.push(m), { secrets: ['my-app-secret-value'] });
  lg.error([{ message: 'Request failed', config: { data: { app_secret: 'my-app-secret-value' }, headers: { Authorization: 'Bearer t-zzzzzzzzzzzzzzzzzzzzzzzz' } } }]);
  lg.error({ response: { data: { code: 10014, msg: 'app secret invalid' } }, config: { data: 'my-app-secret-value' } });
  lg.debug('[ws]', 'receive message, data: {"token":"verification-token"}');
  lg.info(['[ws]', 'ws client ready']);
  const all = lines.join('\n');
  assert.ok(!all.includes('my-app-secret-value') && !all.includes('t-zzzz') && !all.includes('verification-token'), all);
  assert.ok(all.includes('Request failed') && all.includes('code 10014') && all.includes('ws client ready'));
});

/* ---------------- outbound ---------------- */
test('reply: receive_id_type from the id, Markdown stripped, long text split, retry keeps the uuid', async () => {
  assert.strictEqual(receiveIdType(OWNER), 'open_id'); assert.strictEqual(receiveIdType('oc_chat0000000001'), 'chat_id');
  assert.strictEqual(receiveIdType('on_x'), null); assert.strictEqual(receiveIdType('-rf'), null);
  let fails = 1;
  const api = fakeApi({ sendImpl: (a) => { if (fails-- > 0) throw new LarkError({ label: 'NETWORK', msg: 'ECONNRESET' }); return 'om_x'; } });
  const r = await sendText('**bold** and `code`\n\n' + 'word '.repeat(2000), { api, target: { to: OWNER }, sleep: async () => {} });
  assert.strictEqual(r.parts, 3);
  const sends = api.calls.filter((c) => c.op === 'send');
  assert.strictEqual(sends.length, 4, 'one retry');
  assert.strictEqual(sends[0].uuid, sends[1].uuid, 'the retry reuses the uuid (Lark deduplicates)');
  assert.ok(sends[1].content.text.startsWith('bold and code'));
  assert.ok(sends.every((s) => s.receiveIdType === 'open_id' && s.msgType === 'text' && s.content.text.length <= 4000));
  const api2 = fakeApi({ sendImpl: () => { throw new LarkError({ label: 'API_ERROR', code: 230013, msg: 'no availability' }); } });
  await assert.rejects(sendText('x', { api: api2, target: { to: OWNER }, sleep: async () => {} }), (e) => e.code === 230013 && e.totalParts === 1 && e.sentParts === 0);
  assert.strictEqual(api2.calls.length, 1, 'API errors are not retried');
  const api3 = fakeApi();
  await sendText('answer', { api: api3, target: { replyTo: 'om_aaaaaaaaaaaa1' } });
  assert.strictEqual(api3.calls[0].replyTo, 'om_aaaaaaaaaaaa1');
});

test('reply media: image and file upload, then send, then caption; validation before any network call', async () => {
  const img = path.join(TMP, 'pic.png'); fs.writeFileSync(img, PNG);
  const doc = path.join(TMP, 'report.pdf'); fs.writeFileSync(doc, '%PDF-1.4 test');
  const bin = path.join(TMP, 'data.bin'); fs.writeFileSync(bin, 'x');
  const api = fakeApi();
  await sendMedia('image', img, 'look', { api, target: { to: 'oc_chat0000000001' } });
  assert.deepStrictEqual(api.calls.map((c) => c.op), ['uploadImage', 'send', 'send']);
  assert.deepStrictEqual(api.calls[1].content, { image_key: 'img_v3_key' }); assert.strictEqual(api.calls[1].msgType, 'image');
  assert.deepStrictEqual(api.calls[2].content, { text: 'look' });
  const api2 = fakeApi();
  await sendMedia('file', doc, '', { api: api2, target: { to: OWNER } });
  assert.deepStrictEqual(api2.calls[0], { op: 'uploadFile', fileName: 'report.pdf', fileType: 'pdf' });
  assert.deepStrictEqual(api2.calls[1].content, { file_key: 'file_v3_key' }); assert.strictEqual(api2.calls.length, 2);
  assert.strictEqual(loadFile(bin).fileType, 'stream');
  assert.throws(() => loadImage(doc), (e) => e.label === 'BAD_IMAGE');
  assert.throws(() => loadImage(path.join(TMP, 'missing.png')), (e) => e.label === 'NO_FILE');
  const empty = path.join(TMP, 'empty.txt'); fs.writeFileSync(empty, '');
  assert.throws(() => loadFile(empty), (e) => e.label === 'EMPTY_MEDIA');
});

/* ---------------- long connection supervisor ---------------- */
function fakeFactories() {
  const clients = []; let dispatcher = null;
  return {
    clients, get dispatcher() { return dispatcher; },
    createDispatcher: (h) => { dispatcher = h; return { handlers: h }; },
    createClient: (hooks) => {
      const c = { hooks, state: 'connecting', started: 0, closed: 0,
        start() { this.started++; }, close() { this.closed++; this.state = 'idle'; }, getConnectionStatus() { return { state: this.state }; } };
      clients.push(c); return c;
    },
  };
}
function conn(extra = {}) {
  const f = fakeFactories(); const states = []; const logs = []; const got = []; let alive = 0; let t = 0; const fatals = [];
  const c = new LongConnection({ cfg: {}, factories: f, onMessage: (e) => got.push(e), onState: (s) => states.push(s), onAlive: () => { alive++; },
    onFatal: (s) => fatals.push(s), logFn: (m) => logs.push(m), mono: () => t, backoff: new Backoff({ baseMs: 10, maxMs: 10, random: () => 0 }),
    watchdogEveryMs: 1e9, staleMs: 1000, notConnectedMs: 500, clockOpts: { intervalMs: 1e9 }, ...extra });
  return { c, f, states, logs, got, fatals, alive: () => alive, tick: (ms) => { t += ms; c.tick(); } };
}

test('long connection: ready -> RUNNING, events are passed through, status and stop', () => {
  const x = conn(); x.c.start();
  assert.deepStrictEqual(x.states, ['STARTING']);
  x.f.clients[0].state = 'connected'; x.f.clients[0].hooks.onReady();
  assert.deepStrictEqual(x.states, ['STARTING', 'RUNNING']); assert.ok(x.alive() > 0);
  x.f.dispatcher[EVENT]({ event_id: 'e' });
  assert.deepStrictEqual(x.got, [{ event_id: 'e' }]);
  assert.strictEqual(x.c.status().everConnected, true);
  x.c.stop(); assert.strictEqual(x.f.clients[0].closed, 1);
});

test('long connection: wake-up replaces the client at once; old client callbacks are ignored', async () => {
  const x = conn(); x.c.start(); x.f.clients[0].hooks.onReady();
  x.c.wake(120_000);
  await new Promise((r) => setTimeout(r, 5));
  assert.strictEqual(x.f.clients[0].closed, 1); assert.strictEqual(x.f.clients.length, 2); assert.strictEqual(x.f.clients[1].started, 1);
  assert.ok(x.logs.some((l) => /clock jump 120s/.test(l)));
  const before = x.states.length; x.f.clients[0].hooks.onReconnecting();
  assert.strictEqual(x.states.length, before, 'stale client ignored');
  x.c.stop();
});

test('long connection: watchdog replaces a client that never connects or whose pongs stopped', async () => {
  const x = conn(); x.c.start();
  x.tick(600); // not connected for > notConnectedMs
  await new Promise((r) => setTimeout(r, 20));
  assert.strictEqual(x.f.clients.length, 2);
  const c2 = x.f.clients[1]; c2.state = 'connected'; c2.hooks.onReady();
  x.tick(100); assert.strictEqual(x.f.clients.length, 2, 'healthy: nothing happens');
  x.tick(2000); // no pong for > staleMs while "connected"
  await new Promise((r) => setTimeout(r, 5));
  assert.strictEqual(x.f.clients.length, 3);
  x.c.stop();
});

test('long connection: retryable terminal errors restart; repeated endpoint refusals become fatal', async () => {
  const x = conn({ fatalAfter: 2 }); x.c.start();
  x.f.clients[0].hooks.onError(new Error('WebSocket reconnect exhausted after 5 attempts'));
  await new Promise((r) => setTimeout(r, 20));
  assert.strictEqual(x.f.clients.length, 2); assert.deepStrictEqual(x.fatals, []);
  x.f.clients[1].hooks.onError(new Error('pullConnectConfig failed: code=1000040350, msg=app not enabled'));
  await new Promise((r) => setTimeout(r, 20));
  x.f.clients[2].hooks.onError(new Error('pullConnectConfig failed: code=1000040350, msg=app not enabled'));
  assert.deepStrictEqual(x.fatals, ['LONG_CONNECTION_REJECTED']);
  assert.strictEqual(x.states.at(-1), 'LONG_CONNECTION_REJECTED');
  await new Promise((r) => setTimeout(r, 20));
  assert.strictEqual(x.f.clients.length, 3, 'no restart after a fatal error');
});
