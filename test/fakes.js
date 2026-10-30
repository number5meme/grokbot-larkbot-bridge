'use strict';
// Test doubles: an in-memory store, a fake Lark API, and a fake SDK client. No network.
const { Readable } = require('node:stream');

function memStore() {
  const s = { seen: [], undelivered: [], senders: {}, lastSender: null };
  return Object.assign(s, {
    loadSeen: () => s.seen.slice(), saveSeen: (a) => { s.seen = a.slice(); },
    appendUndelivered: (o) => s.undelivered.push(o), saveLastSender: (id) => { s.lastSender = id; },
    noteSender: (id, ct, at) => { s.senders[id] = { ct, at }; },
  });
}
function memOwner(init = null) { let o = init; return { get: () => o, set: (id) => { o = id; } }; }

/** Fake api for handler / reply tests. resources: { [fileKey]: Buffer | Error }. */
function fakeApi({ resources = {}, sendImpl } = {}) {
  const calls = [];
  return {
    calls,
    async send(a) { calls.push({ op: 'send', ...a }); if (sendImpl) return sendImpl(a, calls); return `om_sent${calls.length}xxxxxxxx`; },
    async uploadImage(stream) { stream.destroy(); calls.push({ op: 'uploadImage' }); return 'img_v3_key'; },
    async uploadFile(stream, o) { stream.destroy(); calls.push({ op: 'uploadFile', ...o }); return 'file_v3_key'; },
    async downloadResource(a) {
      calls.push({ op: 'download', ...a });
      const r = resources[a.fileKey];
      if (r instanceof Error) throw r;
      return { stream: Readable.from(r ? [r] : []), headers: { 'content-type': 'application/octet-stream' } };
    },
  };
}

/** A minimal im.message.receive_v1 event (already parsed by the SDK dispatcher). */
function larkEvent({ id = 'om_aaaaaaaaaaaa1', eventId = 'ev1', sender = 'ou_owner000000001', senderType = 'user', chatType = 'p2p',
  chatId = 'oc_chat0000000001', type = 'text', content = { text: 'hello' }, mentions } = {}) {
  return { schema: '2.0', event_id: eventId, event_type: 'im.message.receive_v1', token: 'verification-token-not-logged',
    sender: { sender_id: { open_id: sender, union_id: 'on_x', user_id: 'u1' }, sender_type: senderType, tenant_key: 't1' },
    message: { message_id: id, chat_id: chatId, chat_type: chatType, message_type: type, content: JSON.stringify(content), create_time: '1700000000000', ...(mentions ? { mentions } : {}) } };
}

module.exports = { memStore, memOwner, fakeApi, larkEvent };
