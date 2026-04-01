'use strict';
require('dotenv').config();
const path = require('path');

module.exports = {
  PORT: process.env.PORT || 3210,
  DB_PATH: process.env.DB_PATH || path.join(__dirname, '..', 'data', 'chat.db'),
  RATE_LIMIT_MS: parseInt(process.env.RATE_LIMIT_MS) || 3000,
  DEFAULT_LIMIT: parseInt(process.env.DEFAULT_LIMIT) || 100,
  MAX_LIMIT: parseInt(process.env.MAX_LIMIT) || 500,
  DEFAULT_LAST_N: parseInt(process.env.DEFAULT_LAST_N) || 10,
  MIN_LAST_N: parseInt(process.env.MIN_LAST_N) || 1,
  MAX_LAST_N: parseInt(process.env.MAX_LAST_N) || 100,
  ADMIN_KEY: process.env.ADMIN_KEY || '',
  HOOK_TIMEOUT_MS: parseInt(process.env.HOOK_TIMEOUT_MS) || 10000,
  ROOM_PER_SERVER: parseInt(process.env.ROOM_PER_SERVER) || 2,
  AGENT_PER_SERVER: parseInt(process.env.AGENT_PER_SERVER) || 2,
  MAX_ROOMS: parseInt(process.env.MAX_ROOMS) || 10,
  MAX_AGENTS: parseInt(process.env.MAX_AGENTS) || 10,
  PENDING_PER_SERVER: parseInt(process.env.PENDING_PER_SERVER) || 2,
};

// 启动安全校验
if (!process.env.ADMIN_KEY || process.env.ADMIN_KEY === 'your_admin_key_here') {
  console.warn('[WARN] ADMIN_KEY is not set or uses placeholder value — Dashboard API is unprotected!');
}
if (process.env.WEBHOOK_TOKEN === 'your_webhook_token_here') {
  console.warn('[WARN] WEBHOOK_TOKEN is using insecure default value — please change it in .env');
}
