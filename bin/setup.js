#!/usr/bin/env node
'use strict';
// Interactive configuration: writes .env in this bridge folder (next to package.json).
const path = require('node:path');
const { COMMON_QUESTIONS, runSetup } = require('../src/setup-common');

const LARK_QUESTIONS = [
  { key: 'LARK_APP_ID', required: true, help: 'App ID of your custom app (Lark developer console, Credentials & Basic Info; starts with cli_).' },
  { key: 'LARK_APP_SECRET', required: true, secret: true, help: 'App Secret of the same app. Input is hidden.' },
  { key: 'LARK_DOMAIN', dflt: 'lark', help: 'lark for Lark international (open.larksuite.com), feishu for Feishu (open.feishu.cn).' },
];

runSetup({ questions: [...LARK_QUESTIONS, ...COMMON_QUESTIONS], file: path.join(__dirname, '..', '.env') })
  .then(() => console.log('Next: ./verify.sh --ws 20, then ./start.sh, then send the bot a direct message in Lark.'))
  .catch((e) => { console.error(e.message); process.exit(1); });
