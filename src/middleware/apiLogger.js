'use strict';
const path = require('path');
const { createRotatingFileStream } = require('../lib/rotatingFileStream');

// 两个独立的日志文件（带轮转）
const SYS_LOG_FILE = path.join(__dirname, '../../logs/api-sys.log');
const AGENTS_LOG_FILE = path.join(__dirname, '../../logs/api-agents.log');

// 详细调试日志（AGENT_LOG_DETAIL=1 时记录 curl 格式的请求详情）
const AGENT_LOG_DETAIL = process.env.AGENT_LOG_DETAIL === '1';
const NOISE_HEADERS = new Set(['host', 'connection', 'content-length', 'accept-encoding', 'accept', 'user-agent']);
const REDACTED_HEADERS = new Set(['authorization', 'cookie']);

const sysStream = createRotatingFileStream(SYS_LOG_FILE, {
  maxSize: 5 * 1024 * 1024,   // 5MB
  maxFiles: 5,                  // 保留 5 个归档
});

const agentsStream = createRotatingFileStream(AGENTS_LOG_FILE, {
  maxSize: 5 * 1024 * 1024,   // 5MB
  maxFiles: 5,                  // 保留 5 个归档
});

function formatTs() {
  const now = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
}

/**
 * 构建 curl 格式的请求详情日志行（单行）
 * 仅在 AGENT_LOG_DETAIL=1 时调用。
 * @param {Object} req - Express 请求对象（用于 method、originalUrl、headers）
 * @param {Object|null} body - 中间件阶段快照的请求体
 * @param {string} timestamp - 格式化的时间戳
 * @param {string|null} agentName - Agent 名称
 */
function buildCurlLine(req, body, timestamp, agentName) {
  const host = req.headers.host || 'localhost';
  const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'http');
  const fullUrl = `${proto}://${host}${req.originalUrl}`;

  const parts = [`curl -X ${req.method} '${fullUrl}'`];

  for (const [key, value] of Object.entries(req.headers)) {
    const lk = key.toLowerCase();
    if (NOISE_HEADERS.has(lk)) continue;
    const safe = REDACTED_HEADERS.has(lk) ? '***' : value;
    parts.push(`-H '${key}: ${safe}'`);
  }

  if (body && typeof body === 'object' && Object.keys(body).length > 0) {
    const bodyStr = JSON.stringify(body).slice(0, 500);
    parts.push(`-d '${bodyStr}'`);
  }

  const prefix = agentName ? `[${agentName}] ` : '';
  return `${timestamp}: ${prefix}[curl] ${parts.join(' ')}\n`;
}

function apiLogger(req, res, next) {
  const timestamp = formatTs();
  const method = req.method;
  const url = req.originalUrl;

  // 根据调用者类型记录响应（包含状态码）
  if (req.isAdmin) {
    logResponse(req, res, timestamp, method, url, null);
  } else if (req.authAgent && req.authAgent.name) {
    logResponse(req, res, timestamp, method, url, req.authAgent.name);
  }
  // [anon] 公开路由不记录，或可选择记录到任一文件

  next();
}

/**
 * 监听响应完成事件，记录包含状态码的日志。
 * 若 AGENT_LOG_DETAIL=1，额外写入 curl 格式的请求详情行。
 * @param {Object} req - Express 请求对象
 * @param {Object} res - Express 响应对象
 * @param {string} timestamp - 格式化的时间戳
 * @param {string} method - HTTP 方法
 * @param {string} url - 请求 URL
 * @param {string|null} agentName - Agent 名称（系统请求为 null）
 */
function logResponse(req, res, timestamp, method, url, agentName) {
  // 在中间件阶段快照 body，防止响应结束后被修改
  const bodySnapshot = AGENT_LOG_DETAIL ? req.body : null;

  res.on('finish', () => {
    const statusCode = res.statusCode;
    let logLine;

    if (agentName) {
      logLine = `${timestamp}: [${agentName}] ${method} ${url} ${statusCode}\n`;
    } else {
      logLine = `${timestamp}: ${method} ${url} ${statusCode}\n`;
    }

    const stream = agentName ? agentsStream : sysStream;
    stream.write(logLine);

    if (AGENT_LOG_DETAIL) {
      stream.write(buildCurlLine(req, bodySnapshot, timestamp, agentName));
    }
  });
}

module.exports = apiLogger;
