#!/usr/bin/env node
'use strict';
// Send a plain-text message, an image or a file as the bot.
// Recommended (no shell quoting problems): ./reply.sh --to <sender_id|chat_id> --stdin <<'EOF_REPLY' ... EOF_REPLY
// Prints "OK" (exit 0) or "ERROR <code>" (exit non-zero) with a hint on stderr. Exit codes: 1 generic,
// 2 usage / configuration, 16 BAD_CREDENTIALS.
const path = require('node:path');
const C = require('../src/config');
const F = require('../src/files');
const { createLarkApi, createSdkClient, LarkError } = require('../src/lark-api');
const { sendText, sendMedia, loadImage, loadFile, receiveIdType, validMessageId } = require('../src/reply');
const { checkSendablePath } = require('../src/outbound');

const MEDIA_FLAGS = { '--image': 'image', '--file': 'file' };
const LOADERS = { image: loadImage, file: loadFile };

const USAGE = `Usage: ./reply.sh --to <sender_id|chat_id> --stdin <<'EOF'      (recommended: text on stdin)
       ./reply.sh --to <sender_id|chat_id> [--] "plain text"
       ./reply.sh --to <sender_id|chat_id> --image <file.png|jpg|gif|webp|bmp> [--stdin | -- "caption"]
       ./reply.sh --to <sender_id|chat_id> --file <any file> [--stdin | -- "caption"]
       ./reply.sh --reply-to <message_id> --stdin <<'EOF'   (answer under that message)
Options: --to <id>        recipient: the payload's sender_id (ou_..., direct message), its chat_id (oc_...),
                          or "owner" for the bound owner
         --reply-to <id>  reply under the payload's message_id (om_...); --to is then optional
         --stdin          read the text (or the caption) from stdin; use a quoted heredoc (<<'EOF')
         --image/--file <file>  send media (one per call; images up to 10 MB, files up to 30 MB)
         --               end of options (text may then start with '-')
         -h, --help       show this help
Text without --stdin or arguments is also read from stdin when stdin is not a terminal.
Prints OK (exit 0) or ERROR <code> (exit non-zero; usage errors exit 2).`;

function parseArgs(argv) {
  const out = { to: '', replyTo: '', rest: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--to' || a === '--reply-to') {
      const v = argv[i + 1];
      const key = a === '--to' ? 'to' : 'replyTo';
      if (v === undefined || v === '' || v.startsWith('-')) { out.bad = `${a} needs an id, got ${v === undefined ? '(missing)' : v === '' ? '(empty)' : v}`; break; }
      out[key] = v; i++;
    } else if (MEDIA_FLAGS[a]) {
      const kind = MEDIA_FLAGS[a];
      if (out.kind && out.kind !== kind) out.conflict = true;
      out.kind = kind; out[kind] = argv[++i] || '';
    } else if (a === '--stdin') out.stdin = true;
    else if (a === '-h' || a === '--help') { out.help = true; break; }
    else if (a === '--') { out.rest.push(...argv.slice(i + 1)); break; }
    else if (a.startsWith('-') && a !== '-') { out.unknown = a; break; }
    else out.rest.push(a);
  }
  return out;
}

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { console.log(USAGE); process.exit(0); }
  const usage = (detail) => { console.log(`ERROR USAGE${detail ? ' ' + detail : ''}`); console.error(USAGE); process.exit(2); };
  if (args.unknown) usage(`unknown option ${args.unknown}`);
  if (args.conflict) usage('use only one of --image, --file per call');
  if (args.bad) usage(args.bad);
  if (args.to && args.to !== 'owner' && !receiveIdType(args.to)) usage('invalid --to: expected an open_id (ou_...) or chat_id (oc_...)');
  if (args.replyTo && !validMessageId(args.replyTo)) usage('invalid --reply-to: expected a message_id (om_...)');
  if (args.stdin && args.rest.length) usage('use either --stdin or text arguments, not both');
  let cfg;
  try { cfg = C.loadConfig({ requireWebhook: false }); } catch (e) { console.log('ERROR CONFIG'); console.error(e.message); process.exit(2); }
  const P = C.paths(cfg);
  const log = F.makeLogger(P.log);
  const fail = (label, exit, detail) => { console.log(`ERROR ${label}`); if (detail) console.error(detail); log(`reply ERROR ${label}`); process.exit(exit); };

  let raw = ''; let mediaPath = ''; let caption = args.rest.join(' ');
  if (args.kind) {
    if (!args[args.kind]) fail('NO_FILE', 1, `usage: ./reply.sh --to <id> --${args.kind} <file> [--stdin | -- "caption"]`);
    mediaPath = path.resolve(process.env.REPLY_CWD || process.cwd(), args[args.kind]);
    try {
      LOADERS[args.kind](mediaPath); // validate before any network call
      checkSendablePath(mediaPath, { root: C.ROOT, stateDir: cfg.stateDir, mediaDir: cfg.mediaDir, allowedDirs: cfg.replyAllowedDirs });
    } catch (e) { fail(e.label || 'BAD_FILE', 1, e.message); }
    if (args.stdin) caption = await readStdin();
  } else {
    if (args.rest.length) raw = args.rest.join(' ');
    else if (args.stdin || !process.stdin.isTTY) raw = await readStdin();
    if (!raw || !raw.trim()) fail('EMPTY_TEXT', 1, 'usage: ./reply.sh --to <id> --stdin <<\'EOF\' ... (or text after --)');
  }
  if (!args.to && !args.replyTo) fail('NO_RECIPIENT', 2, '--to is required: pass the payload\'s sender_id or chat_id (or "owner"), or use --reply-to <message_id>');
  let to = args.to;
  if (to === 'owner') {
    to = cfg.ownerId || C.ownerStore(P).get();
    if (!to) fail('NO_RECIPIENT', 1, 'no owner is bound yet: set OWNER_ID (see ./senders.sh) or pass --to <open_id>');
    if (!receiveIdType(to)) fail('NO_RECIPIENT', 1, 'the owner id is not a Lark open_id (ou_...)');
  }
  if (!to && args.kind && caption.trim()) fail('USAGE', 2, 'a caption needs --to as well as --reply-to');
  const api = createLarkApi({ client: createSdkClient(cfg, log), secrets: [cfg.appSecret] });
  const target = { to, replyTo: args.replyTo || undefined };
  try {
    await F.withFileLock(P.replyLock, async () => {
      if (mediaPath) {
        const r = await sendMedia(args.kind, mediaPath, caption, { api, target });
        log(`reply ${args.kind} OK ${r.size}B caption_parts=${r.captionParts}`);
      } else {
        const r = await sendText(raw, { api, target });
        log(`reply OK parts=${r.parts}`);
      }
    });
    console.log('OK');
  } catch (e) {
    const where = e.totalParts ? `sent ${e.sentParts}/${e.totalParts}` : e.stage ? `${args.kind || 'media'} ${e.stage}` : '';
    if (e instanceof LarkError) {
      if (e.badCredentials) { F.writeSecure(P.status, 'BAD_CREDENTIALS\n'); fail('BAD_CREDENTIALS', C.EXIT.BAD_CREDENTIALS, C.FATAL_STATUS.BAD_CREDENTIALS); }
      const label = e.code !== null ? `LARK_${e.code}` : e.label;
      fail(label, 1, `${e.larkMsg || e.label}${e.scopeMissing ? ' (a permission scope is missing; see README "Permissions")' : ''} ${where}`.trim());
    }
    fail(e.label || 'INTERNAL', 1, `${e.message} ${where}`.trim());
  }
}

module.exports = { parseArgs, USAGE };
if (require.main === module) main().catch((e) => { console.log('ERROR INTERNAL'); console.error(e.message); process.exit(1); });
