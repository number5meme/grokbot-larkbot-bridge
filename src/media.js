'use strict';
// Inbound Lark attachments -> local files, downloaded with the official message resource API
// (GET /open-apis/im/v1/messages/:message_id/resources/:file_key?type=image|file, scope im:resource).
// The download is streamed and aborted once it exceeds MEDIA_MAX_MB. A failed download never drops the message:
// the entry is kept with path null and an error label, like the other bridges.
const { labeled } = require('./media-store');

/** Read a Node readable stream into a Buffer, failing with TOO_LARGE past maxBytes. */
async function readCapped(stream, maxBytes) {
  const parts = []; let n = 0;
  try {
    for await (const chunk of stream) {
      n += chunk.length;
      if (n > maxBytes) { try { stream.destroy(); } catch { /* ignore */ } throw labeled('TOO_LARGE', 'media is larger than the cap'); }
      parts.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
  } catch (e) { if (e.label) throw e; throw labeled('NETWORK', 'media download failed'); }
  return Buffer.concat(parts, n);
}

/** resources: from extractMessage. Returns payload media entries [{ kind, path, content_type, size, filename?, error? }]. */
async function fetchLarkMedia(messageId, resources, { api, store }) {
  const out = [];
  for (const r of resources) {
    const entry = { kind: r.kind };
    try {
      const { stream, headers } = await api.downloadResource({ messageId, fileKey: r.key, type: r.type });
      const len = Number(headers && headers['content-length']);
      if (Number.isFinite(len) && len > store.maxBytes) { try { stream.destroy(); } catch { /* ignore */ } throw labeled('TOO_LARGE', 'media is larger than the cap'); }
      const buf = await readCapped(stream, store.maxBytes);
      const ct = String((headers && headers['content-type']) || '').split(';')[0].trim();
      const saved = store.save(buf, { kind: r.kind, contentType: ct && ct !== 'application/octet-stream' ? ct : undefined, filename: r.filename });
      Object.assign(entry, saved);
    } catch (e) {
      entry.path = null;
      entry.error = typeof e.code === 'number' ? `LARK_${e.code}` : (e.label || 'DOWNLOAD_FAILED');
      if (r.filename) entry.filename = String(r.filename).slice(0, 200);
    }
    out.push(entry);
  }
  return out;
}

module.exports = { fetchLarkMedia, readCapped };
