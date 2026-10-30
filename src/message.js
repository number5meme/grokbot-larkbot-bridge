'use strict';
// Lark message content -> plain text plus a list of downloadable resources.
// Content is the JSON string from im.message.receive_v1 (message.content). Supported types: text, post (rich text),
// image, file, audio, media (video), sticker; anything else becomes a short "[type]" marker.
// Mentions: "@_user_N" placeholders are replaced with "@Name"; mentions of the bot itself are removed.

const MAX_RESOURCES = 10;

function parseContent(raw) {
  if (raw && typeof raw === 'object') return raw;
  try { const o = JSON.parse(String(raw || '')); return o && typeof o === 'object' ? o : {}; } catch { return {}; }
}

/** True when the mention refers to the bot (by open_id, or, when the bot open_id is unknown, an app mention). */
function isBotMention(m, botOpenId) {
  const id = (m && m.id) || {};
  if (botOpenId) return id.open_id === botOpenId;
  return !id.user_id && !id.union_id && Boolean(id.open_id); // apps carry no user_id / union_id
}

function mentionMap(mentions, botOpenId) {
  const map = new Map();
  for (const m of Array.isArray(mentions) ? mentions : []) {
    if (!m || !m.key) continue;
    map.set(m.key, isBotMention(m, botOpenId) ? '' : `@${m.name || 'user'}`);
  }
  return map;
}

function replaceMentions(text, map) {
  let s = String(text || '');
  // Longest keys first so "@_user_10" is not consumed by "@_user_1".
  for (const k of [...map.keys()].sort((a, b) => b.length - a.length)) s = s.split(k).join(map.get(k));
  s = s.replace(/@_all\b/g, '@all');
  return s.replace(/[ \t]{2,}/g, ' ').replace(/^[ \t]+|[ \t]+$/gm, '').trim();
}

/** Post (rich text) -> text lines; collects img/media resources. Accepts { title, content } or { <locale>: {...} }. */
function postToText(c, map, resources) {
  let body = c;
  if (!Array.isArray(body.content)) {
    const loc = Object.values(c).find((v) => v && typeof v === 'object' && Array.isArray(v.content));
    body = loc || { content: [] };
  }
  const lines = [];
  if (body.title) lines.push(String(body.title));
  for (const para of body.content || []) {
    if (!Array.isArray(para)) continue;
    let line = '';
    for (const el of para) {
      if (!el || typeof el !== 'object') continue;
      switch (el.tag) {
        case 'text': case 'md': line += el.text || ''; break;
        case 'a': line += el.text && el.href && el.text !== el.href ? `${el.text} ${el.href}` : (el.href || el.text || ''); break;
        case 'at': {
          const key = el.user_id || '';
          if (map.has(key)) line += map.get(key); else if (key === 'all' || key === '@_all') line += '@all'; else line += `@${el.user_name || 'user'}`;
          break;
        }
        case 'code_block': line += `${line ? '\n' : ''}${el.text || ''}`; break;
        case 'emotion': line += el.emoji_type ? `[${el.emoji_type}]` : ''; break;
        case 'img': if (el.image_key) resources.push({ kind: 'image', key: el.image_key, type: 'image' }); break;
        case 'media': if (el.file_key) resources.push({ kind: 'video', key: el.file_key, type: 'file' }); break;
        case 'hr': line += '\n'; break;
        default: if (typeof el.text === 'string') line += el.text;
      }
    }
    lines.push(line);
  }
  return lines.join('\n');
}

/**
 * message: the event's message object. Returns { text, resources: [{ kind, key, type, filename? }], mentionedBot }.
 * kind: image | file | voice | video (the payload's media kinds); type: the resource API "type" (image | file).
 */
function extractMessage(message, { botOpenId = '' } = {}) {
  const msg = message || {};
  const c = parseContent(msg.content);
  const map = mentionMap(msg.mentions, botOpenId);
  const mentionedBot = (Array.isArray(msg.mentions) ? msg.mentions : []).some((m) => isBotMention(m, botOpenId));
  const resources = [];
  let text = '';
  switch (msg.message_type) {
    case 'text': text = c.text || ''; break;
    case 'post': text = postToText(c, map, resources); break;
    case 'image': if (c.image_key) resources.push({ kind: 'image', key: c.image_key, type: 'image' }); break;
    case 'file': if (c.file_key) resources.push({ kind: 'file', key: c.file_key, type: 'file', filename: c.file_name }); break;
    case 'audio': if (c.file_key) resources.push({ kind: 'voice', key: c.file_key, type: 'file', filename: c.file_name }); break;
    case 'media': if (c.file_key) resources.push({ kind: 'video', key: c.file_key, type: 'file', filename: c.file_name }); break;
    case 'sticker': text = '[sticker]'; break;
    default: text = msg.message_type ? `[${String(msg.message_type).replace(/[^a-z_]/gi, '').slice(0, 30)}]` : '';
  }
  return { text: replaceMentions(text, map), resources: resources.slice(0, MAX_RESOURCES), mentionedBot };
}

module.exports = { extractMessage, parseContent, replaceMentions, mentionMap, isBotMention, MAX_RESOURCES };
