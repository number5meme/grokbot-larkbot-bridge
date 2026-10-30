# Lark Open Platform notes

The parts of the Lark Open Platform this bridge uses, all through the official Node SDK `@larksuiteoapi/node-sdk`.
Domain: `https://open.larksuite.com` (Lark international) or `https://open.feishu.cn` (Feishu).

## Authentication

The SDK `Client` fetches `tenant_access_token` with `POST /open-apis/auth/v3/tenant_access_token/internal`
(`app_id`, `app_secret`), caches it, and refreshes it before expiry. Bad credentials: code `10003` (app id) or `10014`
(app secret).

## Long connection (event subscription)

`WSClient.start({ eventDispatcher })`:

1. `POST {domain}/callback/ws/endpoint` with the app id and secret returns a WebSocket URL and client config
   (ping interval, reconnect count and interval). A non-zero code is reported as `pullConnectConfig failed: code=...`.
2. The client connects, sends protobuf ping frames, and receives event frames, which it acknowledges after the
   dispatcher returns. Events not acknowledged within about 3 s are redelivered, so the same message can arrive twice:
   dedupe by `message_id` and `event_id`.
3. The console's "persistent connection" subscription mode can only be saved while a connection is open.

## im.message.receive_v1

The dispatcher passes the event merged with its header:

```json
{
  "event_id": "...", "event_type": "im.message.receive_v1",
  "sender": { "sender_id": { "open_id": "ou_...", "union_id": "on_...", "user_id": "..." }, "sender_type": "user", "tenant_key": "..." },
  "message": { "message_id": "om_...", "chat_id": "oc_...", "chat_type": "p2p", "message_type": "text",
               "content": "{\"text\":\"@_user_1 hello\"}", "mentions": [{ "key": "@_user_1", "id": { "open_id": "ou_..." }, "name": "Bot" }] }
}
```

`content` is a JSON string: `text` `{ text }`; `post` `{ title, content: [[{ tag, ... }]] }` (possibly keyed by locale);
`image` `{ image_key }`; `file` `{ file_key, file_name }`; `audio` `{ file_key, duration }`; `media` `{ file_key, image_key, file_name }`.

## Endpoints

| Purpose | Endpoint | Scope |
|---|---|---|
| Bot info | `GET /open-apis/bot/v3/info` | none (bot capability) |
| Send | `POST /open-apis/im/v1/messages?receive_id_type=open_id` or `chat_id` | `im:message:send_as_bot` |
| Reply | `POST /open-apis/im/v1/messages/:message_id/reply` | `im:message:send_as_bot` |
| Upload image | `POST /open-apis/im/v1/images` (`image_type=message`, max 10 MB) | `im:resource` |
| Upload file | `POST /open-apis/im/v1/files` (`file_type` pdf, doc, xls, ppt or stream; max 30 MB) | `im:resource` |
| Download | `GET /open-apis/im/v1/messages/:message_id/resources/:file_key?type=image` or `type=file` | `im:resource` |

Messages carry a `uuid`; Lark deduplicates sends with the same uuid for one hour.

## Error codes seen by the bridge

| Code | Meaning |
|---|---|
| 10003 / 10014 | invalid app id / app secret |
| 99991672 | the app lacks a scope (the message lists it) |
| 99991663 / 99991661 | invalid / missing access token |
| 40004 / 41050 | contact API: outside the app's contact data range |
| 230001 | invalid receive_id |
| 230002 | the bot is not in the chat |
| 230013 | the user is outside the bot's availability range |
