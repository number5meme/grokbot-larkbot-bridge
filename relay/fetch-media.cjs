#!/usr/bin/env node
'use strict';
// Download one attachment of a relayed Lark message onto this machine, using the bridge's own config (.env in the
// parent folder: LARK_APP_ID / LARK_APP_SECRET / MEDIA_DIR) and the official SDK message resource API.
// Usage: node relay/fetch-media.cjs --message-id <om_...> --key <file_key|image_key> --type image|file [--kind image|file|voice|video] [--filename name]
// Prints one JSON media entry ({ kind, path, content_type, size, filename? } or { ..., path: null, error }).
const path = require('node:path');
const root = path.join(__dirname, '..');
const C = require(path.join(root, 'src/config'));
const { createLarkApi, createSdkClient } = require(path.join(root, 'src/lark-api'));
const { createMediaStore } = require(path.join(root, 'src/media-store'));
const { fetchLarkMedia } = require(path.join(root, 'src/media'));

function arg(name) { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : undefined; }

async function main() {
  const messageId = arg('message-id'); const key = arg('key'); const type = arg('type') || 'file';
  if (!messageId || !key || !['image', 'file'].includes(type)) {
    console.error('usage: fetch-media.cjs --message-id <id> --key <file_key> --type image|file [--kind k] [--filename n]');
    process.exit(2);
  }
  const kind = arg('kind') || (type === 'image' ? 'image' : 'file');
  const cfg = C.loadConfig({ requireWebhook: false });
  const api = createLarkApi({ client: createSdkClient(cfg, () => {}), secrets: [cfg.appSecret] });
  const store = createMediaStore({ dir: cfg.mediaDir, maxBytes: cfg.mediaMaxBytes, retentionDays: cfg.mediaRetentionDays });
  const [entry] = await fetchLarkMedia(messageId, [{ kind, key, type, filename: arg('filename') }], { api, store });
  console.log(JSON.stringify(entry));
  process.exit(entry.error ? 1 : 0);
}
main().catch((e) => { console.error(`ERROR ${e.message}`); process.exit(1); });
