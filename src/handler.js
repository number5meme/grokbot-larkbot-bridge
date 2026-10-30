'use strict';
// im.message.receive_v1 handling: dedupe, group filter, sender protection, media download, forwarding.
// The payload has the same shape as the other chat bridges (see guard.buildPayload) plus chat_id and chat_type.
// The handler runs behind a serial queue (src/queue.js); salvage() turns events that could not be finished before
// shutdown into undelivered payloads (flagged "interrupted": true), so nothing is silently lost.
const { buildPayload } = require('./guard');
const { extractMessage } = require('./message');

const SEEN_MAX = 1000;

function fields(ev) {
  const m = (ev && ev.message) || {};
  const s = (ev && ev.sender) || {};
  return {
    eventId: ev && ev.event_id ? String(ev.event_id) : '',
    messageId: m.message_id ? String(m.message_id) : '',
    senderId: s.sender_id && s.sender_id.open_id ? String(s.sender_id.open_id) : '',
    senderType: s.sender_type || '',
    chatId: m.chat_id ? String(m.chat_id) : '',
    chatType: m.chat_type === 'group' ? 'group' : (m.chat_type === 'p2p' ? 'p2p' : String(m.chat_type || '')),
    createMs: Number(m.create_time) || 0,
    message: m,
  };
}

/** The forwarded payload: the common bridge payload plus chat_id and chat_type right after message_id. */
function larkPayload(base, f) {
  const p = buildPayload(base);
  const { source, sender_id, message_id, ...rest } = p;
  return { source, sender_id, message_id, chat_id: f.chatId, chat_type: f.chatType, ...rest };
}

/**
 * store: { loadSeen(), saveSeen(arr), saveLastSender(id), noteSender(id, chatType, iso), appendUndelivered(obj) }
 * getBotOpenId(): the bot's own open_id (to strip @bot and to check group mentions); may return ''.
 * fetchMedia(messageId, resources) -> media entries; null disables media.
 * Returns 'forwarded' | 'undelivered' | 'duplicate' | 'dropped' | 'rate_limited' | 'not_mentioned' | 'not_user' | 'non_text' | 'invalid'.
 */
function makeLarkHandler({ store, guard, forward, mirror = true, logFn = () => {}, now = Date.now, fetchMedia = null,
  getBotOpenId = () => '', groupRequireMention = true }) {
  const seenArr = (store.loadSeen() || []).slice(-SEEN_MAX);
  const seen = new Set(seenArr);
  const known = new Set();
  const inflight = new Map();
  const remember = (...ids) => {
    for (const id of ids.filter(Boolean)) { seen.add(id); seenArr.push(id); }
    while (seenArr.length > SEEN_MAX) seen.delete(seenArr.shift());
    store.saveSeen(seenArr);
  };

  /** Shared checks. Returns { stop: reason } or { f, ex, decision }. */
  function prepare(ev) {
    const f = fields(ev);
    if (!f.messageId || !f.senderId) { logFn('drop event without message_id / sender open_id'); return { stop: 'invalid' }; }
    if (seen.has(f.messageId) || (f.eventId && seen.has(`ev:${f.eventId}`))) { logFn('skip duplicate message'); return { stop: 'duplicate' }; }
    remember(f.messageId, f.eventId ? `ev:${f.eventId}` : '');
    if (f.senderType && f.senderType !== 'user') { logFn(`drop message from sender_type=${String(f.senderType).slice(0, 20)}`); return { stop: 'not_user' }; }
    const ex = extractMessage(f.message, { botOpenId: getBotOpenId() });
    if (f.chatType === 'group' && groupRequireMention && !ex.mentionedBot) { logFn('drop group message that does not mention the bot'); return { stop: 'not_mentioned' }; }
    const iso = new Date(now()).toISOString();
    // Sender open_ids (never names) are logged once and kept in senders.json, so OWNER_ID can be set (./senders.sh).
    if (!known.has(f.senderId)) { known.add(f.senderId); logFn(`sender open_id=${f.senderId} chat_type=${f.chatType}`); }
    try { store.noteSender(f.senderId, f.chatType, iso); } catch { /* ignore */ }
    const decision = guard.check(f.senderId, ex.text);
    if (!decision.forward) return { stop: decision.reason === 'not_owner' ? 'dropped' : decision.reason };
    return { f, ex, decision };
  }

  async function handle(ev) {
    const r = prepare(ev);
    if (r.stop) return r.stop;
    const { f, ex, decision } = r;
    store.saveLastSender(f.senderId);
    const toFetch = fetchMedia ? ex.resources : [];
    if (!ex.text && !toFetch.length) { logFn(`message without text or usable attachments (type ${f.message.message_type}) not forwarded`); return 'non_text'; }
    const receivedMs = now();
    const base = { source: 'lark', senderId: f.senderId, messageId: f.messageId, text: decision.text, truncated: decision.truncated,
      untrusted: decision.untrusted, mirror, receivedAt: new Date(receivedMs) };
    inflight.set(f.messageId, larkPayload(base, f));
    try {
      let media = [];
      if (toFetch.length) {
        try { media = await fetchMedia(f.messageId, toFetch); } catch (e) { logFn(`media handling failed: ${e.label || 'error'}`); media = []; }
        const failed = media.filter((x) => x.error).map((x) => x.error);
        logFn(`inbound media ${media.map((x) => x.kind).join(',')}${failed.length ? ` (failed: ${failed.join(',')})` : ''}`);
      }
      logFn(`inbound ${f.chatType} text len=${ex.text.length}${decision.truncated ? ' (truncated)' : ''}${media.length ? ` media=${media.length}` : ''}`);
      const payload = larkPayload({ ...base, media }, f);
      const ok = await forward(payload);
      if (guard.recordDelivery) guard.recordDelivery(ok);
      if (ok) return 'forwarded';
      try { store.appendUndelivered(payload); } catch { /* ignore */ }
      return 'undelivered';
    } finally { inflight.delete(f.messageId); }
  }

  function salvage(queued = []) {
    let n = 0;
    for (const p of inflight.values()) { try { store.appendUndelivered({ ...p, interrupted: true }); n++; } catch { /* ignore */ } }
    inflight.clear();
    for (const ev of queued) {
      const r = prepare(ev);
      if (r.stop) continue;
      const { f, ex, decision } = r;
      if (!ex.text && !ex.resources.length) continue;
      const p = larkPayload({ source: 'lark', senderId: f.senderId, messageId: f.messageId, text: decision.text, truncated: decision.truncated,
        untrusted: decision.untrusted, mirror }, f);
      try { store.appendUndelivered({ ...p, interrupted: true, attachments: ex.resources.length }); n++; } catch { /* ignore */ }
    }
    return n;
  }

  handle.salvage = salvage;
  handle.inflight = inflight;
  return handle;
}

module.exports = { makeLarkHandler, larkPayload, SEEN_MAX };
