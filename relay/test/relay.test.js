import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { decryptLark, encryptLark, larkSignature, verifySignature, extractMessage, mapMessageEvent, readConfig, safeSlice,
  postWebhook, MEDIA_HINT, HANDLING_HINT } from '../src/lark.js';
import { handleRequest } from '../src/index.js';

const KEY = 'test-encrypt-key';
const BOT = 'ou_bot000000000000000000000000000';
const USER = 'ou_user00000000000000000000000000';
let n = 0;

function msgEvent({ type = 'text', content = { text: 'hello' }, chatType = 'p2p', mentions, senderType = 'user', eventId } = {}) {
  n++;
  return {
    schema: '2.0',
    header: { event_id: eventId || `evt_${n}`, event_type: 'im.message.receive_v1', token: 'vtok', create_time: '1700000000000', app_id: 'cli_x' },
    event: {
      sender: { sender_id: { open_id: USER, user_id: 'u1', union_id: 'on_1' }, sender_type: senderType, tenant_key: 't' },
      message: { message_id: `om_${n}`, chat_id: 'oc_chat1', chat_type: chatType, message_type: type, content: JSON.stringify(content), mentions, create_time: '1700000000000' },
    },
  };
}

async function signedRequest(bodyObj, { key = KEY, encrypt = true, badSig = false } = {}) {
  const raw = encrypt ? JSON.stringify({ encrypt: await encryptLark(JSON.stringify(bodyObj), key) }) : JSON.stringify(bodyObj);
  const ts = '1700000000'; const nonce = 'abc123';
  let sig = await larkSignature(ts, nonce, key, raw);
  if (badSig) sig = '0'.repeat(64);
  return new Request('https://relay.test/', { method: 'POST', body: raw,
    headers: { 'Content-Type': 'application/json', 'X-Lark-Request-Timestamp': ts, 'X-Lark-Request-Nonce': nonce, 'X-Lark-Signature': sig } });
}

function ctxCollector() { const jobs = []; return { jobs, ctx: { waitUntil: (p) => jobs.push(p) }, done: () => Promise.all(jobs) }; }

test('decrypts the Lark documentation vector', async () => {
  assert.equal(await decryptLark('P37w+VZImNgPEO1RBhJ6RtKl7n6zymIbEG1pReEzghk=', 'test key'), 'hello world');
});

test('encrypt/decrypt round trip and signature', async () => {
  const s = JSON.stringify({ a: 1, t: 'x'.repeat(100) });
  assert.equal(await decryptLark(await encryptLark(s, KEY), KEY), s);
  const sig = await larkSignature('1', '2', KEY, 'body');
  assert.match(sig, /^[0-9a-f]{64}$/);
  const h = new Headers({ 'X-Lark-Request-Timestamp': '1', 'X-Lark-Request-Nonce': '2', 'X-Lark-Signature': sig });
  assert.equal(await verifySignature(h, KEY, 'body'), true);
  assert.equal(await verifySignature(h, KEY, 'body2'), false);
  assert.equal(await verifySignature(new Headers(), KEY, 'body'), false);
});

test('extract text, post, mentions, media', () => {
  const ex = extractMessage({ message_type: 'text', content: JSON.stringify({ text: '@_user_1 hi @_user_2' }),
    mentions: [{ key: '@_user_1', id: { open_id: BOT }, name: 'Bot' }, { key: '@_user_2', id: { open_id: 'ou_o', user_id: 'x' }, name: 'Ann' }] }, { botOpenId: BOT });
  assert.equal(ex.text, 'hi @Ann'); assert.equal(ex.mentionedBot, true);
  const post = extractMessage({ message_type: 'post', content: JSON.stringify({ en_us: { title: 'T', content: [[{ tag: 'text', text: 'line ' }, { tag: 'a', text: 'x', href: 'https://e.com' }], [{ tag: 'img', image_key: 'img_1' }]] } }) });
  assert.equal(post.text, 'T\nline x https://e.com'); assert.deepEqual(post.resources, [{ kind: 'image', key: 'img_1', type: 'image' }]);
  const f = extractMessage({ message_type: 'file', content: JSON.stringify({ file_key: 'file_1', file_name: 'a.pdf' }) });
  assert.deepEqual(f.resources, [{ kind: 'file', key: 'file_1', type: 'file', filename: 'a.pdf' }]);
});

test('payload shape matches the bridge', () => {
  const cfg = readConfig({ MIRROR_TO_MAIN_CHAT: 'false', OWNER_PROTECTION: 'off', MAX_MESSAGE_CHARS: '4000' });
  const { payload } = mapMessageEvent(msgEvent(), cfg, () => Date.parse('2026-01-01T00:00:00Z'));
  assert.deepEqual(Object.keys(payload), ['source', 'sender_id', 'message_id', 'chat_id', 'chat_type', 'text', 'truncated', 'received_at', 'untrusted', 'mirror']);
  assert.equal(payload.source, 'lark'); assert.equal(payload.sender_id, USER); assert.equal(payload.chat_type, 'p2p');
  assert.equal(payload.text, 'hello'); assert.equal(payload.truncated, false); assert.equal(payload.untrusted, false); assert.equal(payload.mirror, false);
  assert.equal(payload.received_at, '2026-01-01T00:00:00.000Z');
});

test('truncation, protection hint, media metadata', () => {
  const long = mapMessageEvent(msgEvent({ content: { text: 'a'.repeat(9) + '\u{1F600}' } }), readConfig({ MAX_MESSAGE_CHARS: '10' })).payload;
  assert.equal(long.text, 'a'.repeat(9)); assert.equal(long.truncated, true);
  assert.equal(safeSlice('ab', 5), 'ab');
  const prot = mapMessageEvent(msgEvent(), readConfig({ OWNER_PROTECTION: 'on' })).payload;
  assert.equal(prot.untrusted, true); assert.equal(prot.handling_hint, HANDLING_HINT);
  assert.equal(mapMessageEvent(msgEvent(), readConfig({ OWNER_PROTECTION: 'on', OWNER_ID: 'ou_other' })).skip, 'dropped');
  const img = mapMessageEvent(msgEvent({ type: 'image', content: { image_key: 'img_k' } }), readConfig({})).payload;
  assert.equal(img.text, '');
  assert.deepEqual(img.media, [{ kind: 'image', path: null, error: 'NOT_DOWNLOADED', message_id: img.message_id, file_key: 'img_k', resource_type: 'image' }]);
  assert.equal(img.handling_hint, MEDIA_HINT);
});

test('skips bots, unmentioned group messages', () => {
  const cfg = readConfig({ LARK_BOT_OPEN_ID: BOT });
  assert.equal(mapMessageEvent(msgEvent({ senderType: 'app' }), cfg).skip, 'not_user');
  assert.equal(mapMessageEvent(msgEvent({ chatType: 'group' }), cfg).skip, 'not_mentioned');
  const ok = mapMessageEvent(msgEvent({ chatType: 'group', content: { text: '@_user_1 go' }, mentions: [{ key: '@_user_1', id: { open_id: BOT } }] }), cfg);
  assert.equal(ok.payload.text, 'go');
  assert.ok(mapMessageEvent(msgEvent({ chatType: 'group' }), readConfig({ GROUP_REQUIRE_MENTION: 'false' })).payload);
});

test('url_verification plain and encrypted', async () => {
  const plain = await handleRequest(new Request('https://r/', { method: 'POST', body: JSON.stringify({ type: 'url_verification', challenge: 'c1', token: 't' }) }), {}, null);
  assert.deepEqual(await plain.json(), { challenge: 'c1' });
  const encReq = new Request('https://r/', { method: 'POST', body: JSON.stringify({ encrypt: await encryptLark(JSON.stringify({ type: 'url_verification', challenge: 'c2', token: 't' }), KEY) }) });
  assert.deepEqual(await (await handleRequest(encReq, { LARK_ENCRYPT_KEY: KEY }, null)).json(), { challenge: 'c2' });
  const badTok = new Request('https://r/', { method: 'POST', body: JSON.stringify({ type: 'url_verification', challenge: 'c', token: 'nope' }) });
  assert.equal((await handleRequest(badTok, { LARK_VERIFICATION_TOKEN: 'vtok' }, null)).status, 401);
  assert.equal((await handleRequest(new Request('https://r/'), {}, null)).status, 405);
});

test('signature enforcement and verification token', async () => {
  const env = { LARK_ENCRYPT_KEY: KEY, WEBHOOK_URL: 'http://127.0.0.1:9/' };
  assert.equal((await handleRequest(await signedRequest(msgEvent(), { badSig: true }), env, null)).status, 401);
  const unsigned = new Request('https://r/', { method: 'POST', body: JSON.stringify(msgEvent()) });
  assert.equal((await handleRequest(unsigned, env, null)).status, 401);
  const plainBadTok = new Request('https://r/', { method: 'POST', body: JSON.stringify({ ...msgEvent(), header: { ...msgEvent().header, token: 'bad' } }) });
  assert.equal((await handleRequest(plainBadTok, { LARK_VERIFICATION_TOKEN: 'vtok' }, null)).status, 401);
});

test('forwards to a mock webhook with auth, dedupes, retries', async () => {
  const got = []; let failFirst = 1;
  const srv = http.createServer((req, res) => {
    let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => {
      if (failFirst-- > 0) { res.writeHead(503); return res.end(); }
      got.push({ auth: req.headers.authorization, body: JSON.parse(b) }); res.writeHead(200); res.end('{}');
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${srv.address().port}/hook`;
  const env = { LARK_ENCRYPT_KEY: KEY, WEBHOOK_URL: url, WEBHOOK_AUTH: 'Bearer test', MIRROR_TO_MAIN_CHAT: 'false', LARK_BOT_OPEN_ID: BOT };
  const deps = { sleep: async () => {}, cacheSeen: async () => false };
  try {
    const ev = msgEvent({ content: { text: 'ping' } });
    const c = ctxCollector();
    const res = await handleRequest(await signedRequest(ev), env, c.ctx, deps);
    assert.equal(res.status, 200);
    await c.done();
    assert.equal(got.length, 1);
    assert.equal(got[0].auth, 'Bearer test');
    assert.equal(got[0].body.text, 'ping'); assert.equal(got[0].body.source, 'lark'); assert.equal(got[0].body.mirror, false);
    const c2 = ctxCollector();
    const dup = await handleRequest(await signedRequest(ev), env, c2.ctx, deps);
    assert.deepEqual(await dup.json(), { ok: true, duplicate: true });
    await c2.done(); assert.equal(got.length, 1);
    const c3 = ctxCollector();
    await handleRequest(await signedRequest(msgEvent({ senderType: 'app' })), env, c3.ctx, deps);
    await c3.done(); assert.equal(got.length, 1);
  } finally { srv.close(); }
});

test('postWebhook gives up on 4xx without retry', async () => {
  let calls = 0;
  const ok = await postWebhook({}, { url: 'http://x', fetchImpl: async () => { calls++; return new Response('', { status: 401 }); }, sleep: async () => {} });
  assert.equal(ok, false); assert.equal(calls, 1);
  calls = 0;
  await postWebhook({}, { url: 'http://x', fetchImpl: async () => { calls++; throw new TypeError('net'); }, sleep: async () => {} });
  assert.equal(calls, 3);
});
