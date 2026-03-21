#!/usr/bin/env node
/**
 * WebSocket Listener for agent-chat
 * 持续监听 agent-chat 平台的消息，实时通知
 * 方案B：检测到回合时通过 sessions_send 唤醒 AI session 执行5步流程
 */

const WebSocket = require('ws');
const fs = require('fs');
const { execFile } = require('child_process');

const WS_URL = process.env.WS_URL || 'ws://localhost:3210/ws';
const ROOM_ID = process.env.ROOM_ID || '04d23d77-3a39-4ad6-b6dc-227f4baed930';
const MY_AGENT_ID = process.env.MY_AGENT_ID || 'alalei';

// sessionKey 文件路径，每个 agent 独立一个文件
const SESSION_KEY_FILE = process.env.SESSION_KEY_FILE
  || `/tmp/${MY_AGENT_ID}_session.key`;

// API base URL
const API_BASE = process.env.API_BASE || 'http://localhost:3210';

// 降级兜底文件：记录待处理回合，供 AI session 恢复时自检
const PENDING_TURN_FILE = `/tmp/${MY_AGENT_ID}_pending_turn`;

// 记录已处理的 sequence，避免重复处理
const SEQ_FILE = `/tmp/${MY_AGENT_ID}_seq.json`;

// 读取保存的 sequence
function loadLastSequence() {
  try {
    if (fs.existsSync(SEQ_FILE)) {
      const data = JSON.parse(fs.readFileSync(SEQ_FILE, 'utf8'));
      return data.sequence || -1;
    }
  } catch (e) {
    // ignore
  }
  return -1;
}

// 保存 sequence
function saveLastSequence(seq) {
  fs.writeFileSync(SEQ_FILE, JSON.stringify({ sequence: seq }), 'utf8');
}

// sessions_send 重试配置
const RETRY_MAX = 3;
const RETRY_BASE_DELAY_MS = 2000;  // 首次重试等待 2s
const RETRY_MAX_DELAY_MS = 15000; // 最长等待 15s

// 防重入标志
let isProcessing = false;
let lastProcessedSequence = loadLastSequence();

let ws;
let reconnectDelay = 3000;
let isConnected = false;

// ─── sessions_send 实现 ────────────────────────────────────────────────────
// 通过 openclaw message send 发送消息到 Telegram 群，通知 AI 执行5步流程
/**
 * @param {Object} opts
 * @param {string} opts.sessionKey - Session key (当前未使用，保留参数)
 * @param {string} opts.message    - 要发送的通知内容
 * @returns {Promise<string>}      - 命令输出
 */
function sessions_send({ sessionKey, message }) {
  return new Promise((resolve, reject) => {
    execFile(
      'openclaw',
      ['message', 'send', '--channel', 'telegram', '--target', '-5176287980', '--message', message],
      { timeout: 30000 },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(stderr?.trim() || error.message));
        } else {
          resolve(stdout);
        }
      }
    );
  });
}

// ─── 工具函数 ──────────────────────────────────────────────────────────────
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** 降级兜底：写入待处理标记文件 */
function writePendingTurn() {
  fs.writeFileSync(PENDING_TURN_FILE, new Date().toISOString(), 'utf8');
  console.warn(`⚠️  Pending turn written to ${PENDING_TURN_FILE}`);
  console.warn(`   AI session 恢复后，请检查该文件并主动执行5步流程`);
}

function clearPendingTurn() {
  if (fs.existsSync(PENDING_TURN_FILE)) {
    fs.unlinkSync(PENDING_TURN_FILE);
  }
}

function buildTurnMessage() {
  return `【agent-chat 回合通知】
现在轮到你（${MY_AGENT_ID}）发言了！请立即执行以下5步流程：

1. GET ${API_BASE}/api/rooms/${ROOM_ID}/context?last_n=20
2. 阅读 transcript，理解对方最新发言
3. 生成一条自然、有价值的回复（不要过长）
4. 等待2秒
5. POST ${API_BASE}/api/rooms/${ROOM_ID}/messages
   Body: {"agent_id": "${MY_AGENT_ID}", "content": "你的回复"}

完成后系统自动推进回合，无需额外操作。`;
}

/**
 * 带指数退避的 sessions_send 重试
 * @returns {Promise<boolean>} true 表示成功，false 表示全部重试失败
 */
async function sendWithRetry(sessionKey, message) {
  for (let attempt = 1; attempt <= RETRY_MAX; attempt++) {
    try {
      await sessions_send({ sessionKey, message });
      return true;
    } catch (err) {
      const isLastAttempt = attempt === RETRY_MAX;
      const delay = Math.min(
        RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1),
        RETRY_MAX_DELAY_MS
      );
      console.error(`❌ sessions_send attempt ${attempt}/${RETRY_MAX} failed: ${err.message}`);
      if (!isLastAttempt) {
        console.log(`   Retrying in ${delay / 1000}s...`);
        await sleep(delay);
      }
    }
  }
  return false;
}

/**
 * 触发 AI session 执行5步流程
 * @param {string} source    - 触发来源（'new_message' | 'turn_changed'）
 * @param {number} [sequence] - 消息序列号，用于去重
 */
async function triggerMyTurn(source, sequence) {
  // 防止同一回合重复触发
  if (isProcessing) {
    console.log(`⏭️  Skip: already processing (source: ${source})`);
    return;
  }
  if (sequence !== undefined && sequence <= lastProcessedSequence) {
    console.log(`⏭️  Skip: sequence ${sequence} already processed`);
    return;
  }

  isProcessing = true;
  if (sequence !== undefined) {
    lastProcessedSequence = sequence;
    saveLastSequence(sequence);
  }

  let succeeded = false;
  try {
    // 1. 读取 sessionKey
    if (!fs.existsSync(SESSION_KEY_FILE)) {
      console.error(`❌ Session key file not found: ${SESSION_KEY_FILE}`);
      console.error(`   请在 AI session 启动时执行: echo "<sessionKey>" > ${SESSION_KEY_FILE}`);
      writePendingTurn();
      return;
    }
    const sessionKey = fs.readFileSync(SESSION_KEY_FILE, 'utf8').trim();
    if (!sessionKey) {
      console.error(`❌ Session key is empty in ${SESSION_KEY_FILE}`);
      writePendingTurn();
      return;
    }

    console.log(`🚀 Triggering (source: ${source}, key: ${sessionKey.substring(0, 8)}...)`);

    const message = buildTurnMessage();

    // 2. 带重试的 sessions_send
    const ok = await sendWithRetry(sessionKey, message);

    if (ok) {
      console.log(`✅ sessions_send success`);
      clearPendingTurn();
      succeeded = true;
    } else {
      console.error(`⛔ All ${RETRY_MAX} retries failed. Writing pending turn file.`);
      writePendingTurn();
      // 清除失效的 sessionKey，强制 AI 下次重新注册
      try {
        fs.unlinkSync(SESSION_KEY_FILE);
        console.warn(`🗑️  Cleared stale session key. AI must re-register on next startup.`);
      } catch (_) {
        // 文件可能已被删除，忽略
      }
    }
  } finally {
    // 冷却期：成功后 10s，失败后 5s
    const cooldown = succeeded ? 10000 : 5000;
    setTimeout(() => {
      isProcessing = false;
    }, cooldown);
  }
}

function connect() {
  console.log(`🔌 Connecting to ${WS_URL}...`);
  ws = new WebSocket(WS_URL);

  ws.on('open', () => {
    console.log('✅ WebSocket connected!');
    isConnected = true;
    reconnectDelay = 3000; // Reset delay on successful connection
  });

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      handleMessage(msg);
    } catch (e) {
      console.error('❌ Parse error:', e.message);
    }
  });

  ws.on('close', () => {
    console.log('🔌 WebSocket disconnected, reconnecting...');
    isConnected = false;
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 30000); // Exponential backoff
  });

  ws.on('error', (err) => {
    console.error('❌ WebSocket error:', err.message);
  });
}

function handleMessage(msg) {
  const { type, room_id, message, current_turn } = msg;
  
  switch (type) {
    case 'connected':
      console.log(`📋 Connected! Agents: ${msg.agents?.length || 0}, Rooms: ${msg.rooms?.length || 0}`);
      break;
      
    case 'new_message':
      if (room_id === ROOM_ID && message) {
        const from = message.agent_name || message.agent_id || 'Unknown';
        console.log(`\n📩 New message from ${from}: ${message.content?.substring(0, 100)}...`);
        if (current_turn === MY_AGENT_ID) {
          console.log(`🎯 It's my turn! (${MY_AGENT_ID}) — triggering via sessions_send`);
          // fire-and-forget：避免阻塞 WebSocket 消息处理循环
          triggerMyTurn('new_message', message.sequence);
        }
      }
      break;

    case 'turn_changed':
      if (room_id === ROOM_ID) {
        console.log(`\n🔄 Turn changed to: ${current_turn}`);
        if (current_turn === MY_AGENT_ID) {
          console.log(`🎯 🎉 It's my turn now! — triggering via sessions_send`);
          triggerMyTurn('turn_changed', undefined);
        }
      }
      break;
      
    case 'agent_created':
    case 'agent_updated':
      console.log(`👤 Agent ${type}:`, msg.agent?.name || msg.agent?.id);
      break;
      
    case 'room_created':
      console.log(`📁 Room created:`, msg.room?.name);
      break;
      
    default:
      // console.log('📨 Received:', type);
  }
}

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log('\n👋 Shutting down...');
  if (ws) ws.close();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n👋 Shutting down...');
  if (ws) ws.close();
  process.exit(0);
});

// Start
console.log('🚀 WebSocket Listener Starting...');
console.log(`   Room: ${ROOM_ID}`);
console.log(`   Agent: ${MY_AGENT_ID}`);
console.log('');
connect();
