'use strict';
// CLI behavior (argument parsing, usage errors, config refusal) and repository hygiene. No network: the CLIs run
// with a preload that exits with NETWORK_CALLED if anything tries to connect.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const { parseArgs } = require('../bin/reply');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'grokbot-larkbot-cli-'));
test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));
const PRELOAD = path.join(__dirname, 'no-network-preload.js');
const BASE_ENV = { PATH: process.env.PATH, HOME: TMP, BRIDGE_NO_DOTENV: '1', STATE_DIR: path.join(TMP, 'state'), LOG_DIR: path.join(TMP, 'logs'),
  LARK_APP_ID: 'cli_0123456789abcdef', LARK_APP_SECRET: 'test-secret-value', NODE_OPTIONS: `--require ${PRELOAD}` };
const run = (cmd, args, { env = {}, input } = {}) => spawnSync(cmd, args, { cwd: ROOT, env: { ...BASE_ENV, ...env }, input, encoding: 'utf8', timeout: 20_000 });

test('parseArgs: recipients, reply-to, media, stdin, end of options', () => {
  assert.deepStrictEqual(parseArgs(['--to', 'ou_abcdefgh12', '--stdin']), { to: 'ou_abcdefgh12', replyTo: '', rest: [], stdin: true });
  assert.deepStrictEqual(parseArgs(['--reply-to', 'om_abcdefgh12', '--', '-text', 'more']), { to: '', replyTo: 'om_abcdefgh12', rest: ['-text', 'more'] });
  assert.strictEqual(parseArgs(['--to', 'oc_abcdefgh12', '--image', 'a.png']).kind, 'image');
  assert.ok(parseArgs(['--image', 'a.png', '--file', 'b']).conflict);
  assert.match(parseArgs(['--to', '--stdin']).bad, /needs an id/);
  assert.strictEqual(parseArgs(['--bogus']).unknown, '--bogus');
});

test('reply.sh: usage errors exit 2 before any network call; --help works', () => {
  for (const args of [['--to', 'not-an-id', '--', 'x'], ['--to', 'ou_abcdefgh12', '--bogus'], ['--reply-to', 'om_bad!', '--', 'x'],
    ['--to', 'ou_abcdefgh12', '--stdin', 'extra'], ['--image', 'a.png', '--file', 'b']]) {
    const r = run('./reply.sh', args, { input: '' });
    assert.strictEqual(r.status, 2, `${args.join(' ')}: ${r.stdout}${r.stderr}`); assert.match(r.stdout, /^ERROR USAGE/);
    assert.ok(!r.stdout.includes('NETWORK_CALLED'));
  }
  const h = run('./reply.sh', ['--help']);
  assert.strictEqual(h.status, 0); assert.match(h.stdout, /--reply-to/);
  const e = run('./reply.sh', ['--to', 'ou_abcdefgh12', '--stdin'], { input: '   ' });
  assert.match(e.stdout, /ERROR EMPTY_TEXT/);
  const s = run('./reply.sh', ['--to', 'ou_abcdefgh12', '--file', '.env.example']);
  assert.match(s.stdout, /ERROR FILE_NOT_ALLOWED/, 'environment files are never sent');
  const o = run('./reply.sh', ['--to', 'owner', '--', 'x']);
  assert.match(o.stdout, /ERROR NO_RECIPIENT/);
  for (const r of [e, s, o]) assert.ok(!r.stdout.includes('NETWORK_CALLED'));
});

test('bridge --check refuses to start without the webhook URL and auth; secrets are not printed', () => {
  const r = run(process.execPath, ['bin/bridge.js', '--check']);
  assert.strictEqual(r.status, 2); assert.match(r.stderr, /FORWARD_WEBHOOK_URL is required/);
  const r2 = run(process.execPath, ['bin/bridge.js', '--check'], { env: { FORWARD_WEBHOOK_URL: 'https://hooks.example.com/x' } });
  assert.strictEqual(r2.status, 2); assert.match(r2.stderr, /FORWARD_WEBHOOK_AUTH is required/);
  const ok = run(process.execPath, ['bin/bridge.js', '--check'], { env: { FORWARD_WEBHOOK_URL: 'https://hooks.example.com/x', FORWARD_WEBHOOK_AUTH: 'Bearer zz-secret' } });
  assert.strictEqual(ok.status, 0, ok.stderr); assert.match(ok.stdout, /config OK/);
  for (const x of [r, r2, ok]) assert.ok(!(x.stdout + x.stderr).includes('test-secret-value') && !(x.stdout + x.stderr).includes('zz-secret'));
});

test('healthcheck and senders: work without credentials or a running bridge', () => {
  const h = run(process.execPath, ['bin/healthcheck.js'], { env: { LARK_APP_ID: '', LARK_APP_SECRET: '' } });
  assert.strictEqual(h.status, 1); assert.match(h.stdout, /UNHEALTHY not running/);
  fs.mkdirSync(BASE_ENV.STATE_DIR, { recursive: true });
  fs.writeFileSync(path.join(BASE_ENV.STATE_DIR, 'senders.json'), JSON.stringify({ ou_abcdefgh12: { first_seen: 'a', last_seen: 'b', count: 2, last_chat_type: 'p2p' } }));
  const s = run('./senders.sh', []);
  assert.strictEqual(s.status, 0); assert.match(s.stdout, /ou_abcdefgh12\tp2p\t2/);
});

/* ---------------- repository hygiene: English only, no personal or deployment details ---------------- */
function listFiles(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', 'state', 'logs', '.git'].includes(e.name) || e.name === '.env' || e.name.startsWith('.env.bak')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) listFiles(p, out); else out.push(p);
  }
  return out;
}

test('hygiene: no CJK text, no app id, no absolute workspace paths in code, docs or tests', () => {
  const appIdRe = new RegExp(['cli', 'aac93d'].join('_'));
  for (const f of listFiles(ROOT)) {
    if (f.endsWith('package-lock.json')) continue;
    const s = fs.readFileSync(f, 'utf8');
    assert.ok(!/[\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uff00-\uffef]/.test(s), `CJK text in ${path.relative(ROOT, f)}`);
    assert.ok(!appIdRe.test(s), `app id in ${path.relative(ROOT, f)}`);
    assert.ok(!/\/workspace\/|\/home\/[a-z]/.test(s), `absolute local path in ${path.relative(ROOT, f)}`);
  }
});
