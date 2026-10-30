'use strict';
// Outbound messages as the bot: plain text (Markdown stripped, split into parts), images and files.
// Recipients: an open_id (ou_..., direct message), a chat_id (oc_..., group or p2p chat), or --reply-to <om_...>
// to answer under a specific message. Every send carries a uuid, so the single retry after a network error or
// 5xx can never produce a duplicate (Lark deduplicates by uuid for one hour).
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { buildChunks } = require('./text');
const { sniffMime, labeled } = require('./media-store');
const { MAX_IMAGE_BYTES, MAX_FILE_BYTES } = require('./config');

const CHUNK = 4000;
const MAX_CHUNKS = 10;
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp'];
const FILE_TYPES = { '.pdf': 'pdf', '.doc': 'doc', '.docx': 'doc', '.xls': 'xls', '.xlsx': 'xls', '.ppt': 'ppt', '.pptx': 'ppt' };

/** Map a recipient id to Lark's receive_id_type, or null when it is not an open_id / chat_id. */
function receiveIdType(to) {
  const s = String(to || '');
  if (/^ou_[A-Za-z0-9]{8,64}$/.test(s)) return 'open_id';
  if (/^oc_[A-Za-z0-9]{8,64}$/.test(s)) return 'chat_id';
  return null;
}
function validMessageId(id) { return /^om_[A-Za-z0-9_]{8,80}$/.test(String(id || '')); }

const retryable = (e) => e && (e.label === 'NETWORK' || (e.httpStatus && e.httpStatus >= 500));
async function withRetry(fn, sleep) {
  try { return await fn(); } catch (e) { if (!retryable(e)) throw e; await sleep(1500); return fn(); }
}

/** Send text in parts. target: { to, replyTo }. Returns { parts }. Errors carry sentParts / totalParts. */
async function sendText(raw, { api, target, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const parts = buildChunks(raw, { chunkSize: CHUNK, maxChunks: MAX_CHUNKS });
  if (!parts.length) throw labeled('EMPTY_TEXT', 'text is empty after Markdown stripping');
  for (let i = 0; i < parts.length; i++) {
    const uuid = crypto.randomUUID();
    try {
      await withRetry(() => api.send({ to: target.to, receiveIdType: receiveIdType(target.to), replyTo: i === 0 ? target.replyTo : undefined,
        msgType: 'text', content: { text: parts[i] }, uuid }), sleep);
    } catch (e) { e.sentParts = i; e.totalParts = parts.length; throw e; }
  }
  return { parts: parts.length };
}

/** Validate an image before any network call. Returns { size, mime }. */
function loadImage(file) {
  let st; try { st = fs.statSync(file); } catch { throw labeled('NO_FILE', 'image file not found'); }
  if (!st.isFile()) throw labeled('NO_FILE', 'not a regular file');
  if (!st.size) throw labeled('EMPTY_MEDIA', 'image is empty');
  if (st.size > MAX_IMAGE_BYTES) throw labeled('TOO_LARGE', 'Lark images are limited to 10 MB (send it with --file instead)');
  const fd = fs.openSync(file, 'r'); const head = Buffer.alloc(16);
  try { fs.readSync(fd, head, 0, 16, 0); } finally { fs.closeSync(fd); }
  const mime = sniffMime(head);
  if (!IMAGE_TYPES.includes(mime)) throw labeled('BAD_IMAGE', 'not a PNG, JPEG, GIF, WEBP or BMP image');
  return { size: st.size, mime };
}

function loadFile(file) {
  let st; try { st = fs.statSync(file); } catch { throw labeled('NO_FILE', 'file not found'); }
  if (!st.isFile()) throw labeled('NO_FILE', 'not a regular file');
  if (!st.size) throw labeled('EMPTY_MEDIA', 'file is empty');
  if (st.size > MAX_FILE_BYTES) throw labeled('TOO_LARGE', 'Lark files are limited to 30 MB');
  return { size: st.size, fileType: FILE_TYPES[path.extname(file).toLowerCase()] || 'stream' };
}

/** Upload and send one image or file, then the optional caption as text. kind: image | file. */
async function sendMedia(kind, file, caption, { api, target, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const info = kind === 'image' ? loadImage(file) : loadFile(file);
  let key;
  try {
    key = kind === 'image'
      ? await api.uploadImage(fs.createReadStream(file))
      : await api.uploadFile(fs.createReadStream(file), { fileName: path.basename(file).slice(0, 200), fileType: info.fileType });
  } catch (e) { e.stage = 'upload'; throw e; }
  const uuid = crypto.randomUUID();
  try {
    await withRetry(() => api.send({ to: target.to, receiveIdType: receiveIdType(target.to), replyTo: target.replyTo, msgType: kind,
      content: kind === 'image' ? { image_key: key } : { file_key: key }, uuid }), sleep);
  } catch (e) { e.stage = 'send'; throw e; }
  let captionParts = 0;
  if (caption && caption.trim()) {
    try { captionParts = (await sendText(caption, { api, target: { to: target.to }, sleep })).parts; } catch (e) { e.stage = 'caption'; throw e; }
  }
  return { kind, size: info.size, captionParts };
}

module.exports = { sendText, sendMedia, loadImage, loadFile, receiveIdType, validMessageId, CHUNK, MAX_CHUNKS };
