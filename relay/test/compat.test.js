// Cross-check the Worker's message extraction against the long-connection bridge (../src/message.js), when present.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { extractMessage } from '../src/lark.js';

const require = createRequire(import.meta.url);
const bridgePath = new URL('../../src/message.js', import.meta.url).pathname;

test('same extraction as the bridge', { skip: !existsSync(bridgePath) }, () => {
  const bridge = require(bridgePath);
  const BOT = 'ou_bot';
  const cases = [
    { message_type: 'text', content: JSON.stringify({ text: '@_user_1  hello  @_user_2 @_all' }), mentions: [{ key: '@_user_1', id: { open_id: BOT } }, { key: '@_user_2', id: { open_id: 'ou_x', user_id: 'u' }, name: 'Bo' }] },
    { message_type: 'post', content: JSON.stringify({ zh_cn: { title: 'Hi', content: [[{ tag: 'text', text: 'a' }, { tag: 'at', user_id: '@_user_1' }, { tag: 'emotion', emoji_type: 'SMILE' }], [{ tag: 'code_block', text: 'x=1' }], [{ tag: 'media', file_key: 'f1' }, { tag: 'img', image_key: 'i1' }]] } }), mentions: [{ key: '@_user_1', id: { open_id: BOT } }] },
    { message_type: 'image', content: JSON.stringify({ image_key: 'img' }) },
    { message_type: 'audio', content: JSON.stringify({ file_key: 'au', file_name: 'v.opus' }) },
    { message_type: 'media', content: JSON.stringify({ file_key: 'vid', file_name: 'v.mp4' }) },
    { message_type: 'sticker', content: '{}' },
    { message_type: 'share_chat', content: '{}' },
  ];
  for (const m of cases) {
    for (const botOpenId of [BOT, '']) assert.deepEqual(extractMessage(m, { botOpenId }), bridge.extractMessage(m, { botOpenId }));
  }
});
