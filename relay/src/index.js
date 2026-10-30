// larkbot-relay: Cloudflare Worker that receives Lark event callbacks over HTTP and forwards
// im.message.receive_v1 messages to a webhook with the same payload shape as the long-connection bridge.
import { decryptLark, verifySignature, bodyToken, safeEqual, readConfig, mapMessageEvent, postWebhook, makeSeenCache } from './lark.js';

const seen = makeSeenCache();
const MAX_BODY = 1024 * 1024;
const DEDUPE_CACHE_HOST = 'https://larkbot-relay.dedupe.invalid/';

const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
const log = (m) => console.log(`[larkbot-relay] ${m}`);

/** Best-effort cross-isolate dedupe via the Cache API (no-op where the Cache API is unavailable). */
async function cacheSeen(id) {
  try {
    if (typeof caches === 'undefined' || !caches.default) return false;
    const key = new Request(DEDUPE_CACHE_HOST + encodeURIComponent(id));
    if (await caches.default.match(key)) return true;
    await caches.default.put(key, new Response('1', { headers: { 'Cache-Control': 'max-age=21600' } }));
  } catch { /* ignore */ }
  return false;
}

export async function handleRequest(request, env, ctx, deps = {}) {
  if (request.method !== 'POST') return json({ error: 'method not allowed' }, 405);
  const cfg = readConfig(env);
  const raw = await request.text();
  if (raw.length > MAX_BODY) return json({ error: 'too large' }, 413);
  let outer;
  try { outer = JSON.parse(raw); } catch { return json({ error: 'bad json' }, 400); }
  if (!outer || typeof outer !== 'object') return json({ error: 'bad json' }, 400);

  let body = outer;
  if (typeof outer.encrypt === 'string') {
    if (!cfg.encryptKey) return json({ error: 'encrypted body but no encrypt key configured' }, 400);
    try { body = JSON.parse(await decryptLark(outer.encrypt, cfg.encryptKey)); } catch { return json({ error: 'decrypt failed' }, 400); }
  }

  const tokenOk = !cfg.verificationToken || safeEqual(bodyToken(body), cfg.verificationToken);

  // URL verification: no signature headers are sent; answer with the challenge (token checked when configured).
  if (body.type === 'url_verification') {
    if (!tokenOk) return json({ error: 'bad token' }, 401);
    return json({ challenge: body.challenge });
  }

  if (cfg.encryptKey) {
    if (!(await verifySignature(request.headers, cfg.encryptKey, raw))) return json({ error: 'bad signature' }, 401);
  }
  if (!tokenOk) return json({ error: 'bad token' }, 401);

  const header = body.header || {};
  const eventType = header.event_type || (body.event && body.event.type) || '';
  if (body.schema !== '2.0' || eventType !== 'im.message.receive_v1') return json({ ok: true, ignored: eventType || 'unknown' });

  const eventId = String(header.event_id || '');
  const messageId = String((body.event && body.event.message && body.event.message.message_id) || '');
  const keys = [eventId && `ev:${eventId}`, messageId && `msg:${messageId}`].filter(Boolean);
  if (keys.some((k) => seen.has(k))) { log('skip duplicate (memory)'); return json({ ok: true, duplicate: true }); }
  keys.forEach((k) => seen.add(k));

  const r = mapMessageEvent(body, cfg, deps.now);
  if (r.skip) { log(`skip ${r.skip}`); return json({ ok: true, skipped: r.skip }); }
  if (!cfg.webhookUrl) { log('WEBHOOK_URL not configured'); return json({ ok: true, skipped: 'no_webhook' }); }

  const work = (async () => {
    const cacheCheck = deps.cacheSeen || cacheSeen;
    if (eventId && (await cacheCheck(`ev:${eventId}`))) { log('skip duplicate (cache)'); return; }
    log(`forward ${r.payload.chat_type} text len=${r.payload.text.length}${r.payload.media ? ` media=${r.payload.media.length}` : ''}`);
    await postWebhook(r.payload, { url: cfg.webhookUrl, auth: cfg.webhookAuth, fetchImpl: deps.fetchImpl || fetch, sleep: deps.sleep, logFn: log });
  })();
  if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(work); else await work;
  return json({ ok: true });
}

export default {
  fetch(request, env, ctx) {
    return handleRequest(request, env, ctx).catch((e) => { log(`error ${e && e.message}`); return json({ ok: false }, 500); });
  },
};
