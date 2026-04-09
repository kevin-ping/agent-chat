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
  MAX_ROOMS: parseInt(process.env.MAX_ROOMS) || 10,
  MAX_AGENTS: parseInt(process.env.MAX_AGENTS) || 10,
};

if (!process.env.ADMIN_KEY || process.env.ADMIN_KEY === 'your_admin_key_here') {
  console.warn('[WARN] ADMIN_KEY is not set or uses placeholder value — Dashboard API is unprotected!');
}
