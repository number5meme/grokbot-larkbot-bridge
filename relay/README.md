# larkbot-relay (Cloudflare Worker)

An always-on relay for hosts that sleep. Lark pushes events over HTTP ("Send events to developer server") to this
Cloudflare Worker, and the Worker forwards each `im.message.receive_v1` message to the same webhook the
long-connection bridge uses, with the same JSON payload. Your webhook (for example a Grok Bot routine) is woken
directly, so messages are received even while the bridge machine is asleep. Replies are still sent from the machine
with `reply.sh`.

```
 Lark user ──> Lark bot ──> Lark event push (HTTPS) ──> larkbot-relay (Cloudflare Worker) ── HTTPS POST (JSON) ──> your webhook
                            Lark OpenAPI <── HTTPS ── reply.sh / relay/fetch-media.sh <────────────────────────── your agent
```

## What it does

- `POST` only (`GET` and others return 405).
- `url_verification` (plain or encrypted) returns `{"challenge": ...}`. Lark does not sign it; the verification token is
  checked when `LARK_VERIFICATION_TOKEN` is set.
- With `LARK_ENCRYPT_KEY` set: `{"encrypt": ...}` bodies are decrypted (AES-256-CBC, key = SHA-256(encrypt key),
  IV = first 16 bytes of the base64-decoded data) and every event must carry a valid
  `X-Lark-Signature = sha256_hex(timestamp + nonce + encrypt_key + raw_body)`, otherwise 401.
- Without `LARK_ENCRYPT_KEY`: plaintext events are accepted; `header.token` / `token` must match
  `LARK_VERIFICATION_TOKEN` when that is set (401 otherwise). Setting an Encrypt Key is strongly recommended.
- Schema 2.0 `im.message.receive_v1` only; other event types get 200 and are ignored.
- Same filters as the bridge: messages whose `sender_type` is not `user` (other bots, the app itself) are dropped, and
  with `GROUP_REQUIRE_MENTION=true` (default) so are group messages that do not @mention the bot. Set
  `LARK_BOT_OPEN_ID` (the `open_id` from `GET /open-apis/bot/v3/info`) for exact mention detection; without it an app
  mention (an open_id without user_id / union_id) counts, like the bridge.
- Text, rich text (post) and the other message types are converted exactly like the bridge (`../src/message.js`;
  a test compares both), and truncated to `MAX_MESSAGE_CHARS` without splitting a surrogate pair.
- Dedupe by `event_id` and `message_id`, best effort: in memory per Worker isolate, plus the Cache API where available.
- Answers Lark with 200 at once and forwards in `ctx.waitUntil`: 3 attempts (backoff 1 s, 3 s; 8 s timeout each),
  retrying on network errors, timeouts, 408, 429 and 5xx. Redirects are not followed.
- Nothing secret and no message text is logged.

## Payload

Same keys and order as the bridge: `source` ("lark"), `sender_id` (open_id), `message_id`, `chat_id`, `chat_type`,
`text`, `truncated`, `received_at`, `untrusted`, `mirror`, optional `media`, optional `handling_hint`.

**Media.** A Worker cannot save files on your machine, so each `media` entry is
`{ kind, path: null, error: "NOT_DOWNLOADED", message_id, file_key, resource_type, filename? }`
(`kind` and the `path: null` + `error` convention match a failed download in the bridge). When media is present,
`handling_hint` tells the agent to fetch the file on the machine before using it:

```sh
relay/fetch-media.sh --message-id <message_id> --key <file_key> --type <resource_type> [--kind <kind>] [--filename <name>]
```

This uses the bridge's `.env` (app credentials, `LARK_DOMAIN`, `MEDIA_DIR`, `MEDIA_MAX_MB`) and its download code, and
prints the usual media entry with a local `path`. Add this step to your routine instructions.

## Configuration

`wrangler.toml` `[vars]`: `MAX_MESSAGE_CHARS`, `GROUP_REQUIRE_MENTION`, `MIRROR_TO_MAIN_CHAT`, `OWNER_PROTECTION`.

Secrets (`npx wrangler secret put NAME`, value read from stdin; changing a secret needs no code redeploy):

| Secret | Required | Meaning |
| --- | --- | --- |
| `WEBHOOK_URL` | yes | webhook to POST payloads to (same as `FORWARD_WEBHOOK_URL`) |
| `WEBHOOK_AUTH` | yes | full `Authorization` header value, e.g. `Bearer <key>` (same as `FORWARD_WEBHOOK_AUTH`) |
| `LARK_ENCRYPT_KEY` | recommended | Encrypt Key from Events & Callbacks -> Encryption Strategy |
| `LARK_VERIFICATION_TOKEN` | optional | Verification Token from the same page |
| `LARK_BOT_OPEN_ID` | optional | the bot's open_id, for exact mention detection |
| `OWNER_ID`, `ALLOWLIST` | optional | with `OWNER_PROTECTION=on`, only these senders are forwarded |

With `OWNER_PROTECTION=on` payloads carry `untrusted: true` and the bridge's handling hint. The Worker is stateless,
so there is no first-sender binding: set `OWNER_ID` (your `sender_id`, see `./senders.sh`).

## Setup

1. Deploy the Worker (needs a free Cloudflare account and an API token with the "Edit Cloudflare Workers" template):

   ```sh
   cd relay
   npm install
   export CLOUDFLARE_API_TOKEN=<token> CLOUDFLARE_ACCOUNT_ID=<account id>
   npx wrangler deploy        # prints https://larkbot-relay.<your-subdomain>.workers.dev
   ```

2. Set the secrets. Values are read from stdin, so they never appear on a command line or in shell history if you
   type them at the prompt:

   ```sh
   npx wrangler secret put WEBHOOK_URL
   npx wrangler secret put WEBHOOK_AUTH
   npx wrangler secret put LARK_ENCRYPT_KEY
   ```

   (Or pipe them: `printf '%s' "$VALUE" | npx wrangler secret put NAME`.)

3. In the Lark developer console, open your app:
   - **Events & Callbacks** -> **Encryption Strategy**: set an **Encrypt Key** (and use the same value for
     `LARK_ENCRYPT_KEY`).
   - **Events & Callbacks** -> **Event configuration** -> subscription mode: choose **Send events to developer
     server** and enter the **Request URL** `https://larkbot-relay.<your-subdomain>.workers.dev/`. Lark verifies the
     URL immediately.
   - Keep the event `im.message.receive_v1` subscribed. The **Callback configuration** tab is not needed.
   - **Version Management & Release**: create a version and publish it, so the change takes effect.

4. Send the bot a message and check the logs with `npx wrangler tail larkbot-relay`.

5. Stop the long-connection bridge (`./stop.sh` in the repository root). Once events go to the request URL, the long connection receives
   nothing, so leaving it running only wastes resources. Keep using `reply.sh` (and `relay/fetch-media.sh`) to send
   replies and fetch media.

**Region.** Lark international reaches `workers.dev` fine. Feishu (China) servers may not be able to reach
`workers.dev`; in that case bind a **Workers Custom Domain** on a domain in your Cloudflare account (Workers ->
`larkbot-relay` -> Settings -> Domains & Routes -> Add -> Custom Domain, e.g. `lark.example.com`) and use that as the
Request URL.

## Caveats

- Dedupe is best effort (per isolate memory plus Cache API); a Lark retry that lands on another isolate can be
  forwarded twice.
- There is no retry queue: if all 3 attempts fail, the message is only logged (`wrangler tail`). The bridge's
  `state/undelivered.jsonl` and `replay.sh` do not apply.
- The request timestamp is not checked for age, so a captured signed request could be replayed after the dedupe
  window.
- Owner protection has no first-sender binding (see above), and rate limits are not applied.

## Tests

```sh
cd relay && npm test     # or, from the repository root: npm run test:relay
```

Unit tests cover decryption (including the example from the Lark docs), signatures, payload mapping, a comparison of
message extraction with the bridge, and forwarding against a local mock webhook. No network access is needed.
