#!/usr/bin/env node
/**
 * WebHook Trigger Agent for agent-chat
 * 
 * 功能：
 * 1. 监听 WebSocket，等待轮到自己发言
 * 2. 调用 OpenClaw webhook 触发 Agent
 * 3. Agent 处理完后会自动发消息到平台，触发下一轮
 * 
 * 使用：
 *   # 阿拉蕾用（agentId: main）
 *   MY_AGENT_ID=alalei node webhook-trigger.js
 *   
 *   # 希米格用（agentId: ximige）
 *   MY_AGENT_ID=ximige node webhook-trigger.js
 */

const WebSocket = require('ws');
// Node 18+ 内置 fetch，无需 require

// ─── 配置 ─────────────────────────────────────────────────────────────────
const WS_URL = process.env.WS_URL || 'ws://localhost:3210/ws';
const ROOM_ID = process.env.ROOM_ID || '493c8ac8-d743-40ea-a9b4-d630e60200d9';
const MY_AGENT_ID = process.env.MY_AGENT_ID || 'alalei';

// OpenClaw Gateway webhook 配置
const GATEWAY_URL = process.env.GATEWAY_URL || 'http://127.0.0.1:18789';
const WEBHOOK_TOKEN = process.env.WEBHOOK_TOKEN || 'my-secret-token';
const SESSION_KEY = process.env.SESSION_KEY || 'agent-chat-discussion';

// Agent ID 映射
const AGENT_ID_MAP = {
  alalei: 'main',
  ximige: 'ximige'
};

// 对方 Agent ID 映射（用于 prompt）
const TARGET_AGENT_ID_MAP = {
  alalei: 'ximige',   // 阿拉蕾 → 希米格
  ximige: 'main'      // 希米格 → 阿拉蕾
};

// 对方名字映射
const TARGET_NAME_MAP = {
  alalei: '希米格',
  ximige: '阿拉蕾'
};

// 自己的名字
const MY_NAME_MAP = {
  alalei: '阿拉蕾',
  ximige: '希米格'
};

// Chat 平台配置
const CHAT_PLATFORM = {
  channel: 'telegram',
  to: '-5176287980'  // 群 ID
};

// ─── 状态 ─────────────────────────────────────────────────────────────────
let ws;
let isProcessing = false;
let lastProcessedSeq = -1;
let reconnectDelay = 3000;

// 记录已处理的 sequence
const SEQ_FILE = `/tmp/${MY_AGENT_ID}_webhook_seq.json`;
const STATUS_FILE = '/tmp/discussion-status.json';
const fs = require('fs');

// 更新进程状态（供 UI 显示 webhook-trigger 是否在线）
function updateStatusFile() {
  try {
    let status = { alalei: false, ximige: false };
    if (fs.existsSync(STATUS_FILE)) {
      status = JSON.parse(fs.readFileSync(STATUS_FILE, 'utf8'));
    }
    // 更新当前 agent 为在线状态
    if (MY_AGENT_ID === 'alalei') {
      status.alalei = true;
    } else if (MY_AGENT_ID === 'ximige') {
      status.ximige = true;
    }
    fs.writeFileSync(STATUS_FILE, JSON.stringify(status, null, 2));
  } catch (e) {
    // ignore
  }
}

// 启动时设置在线状态
updateStatusFile();

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

function saveLastSequence(seq) {
  fs.writeFileSync(SEQ_FILE, JSON.stringify({ sequence: seq }), 'utf8');
}

// ─── Database ─────────────────────────────────────────────────────
// 用于循环检测：查询最近的 Agent 消息
const Database = require('better-sqlite3');
const DB_PATH = process.env.DB_PATH || '/var/www/agent-chat/chat.db';
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

lastProcessedSeq = loadLastSequence();

// ─── Prepared Statements ─────────────────────────────────────────
// 用于循环检测：查询最近的 Agent 消息
const stmts = {
  getRecentMessages: db.prepare(`
    SELECT agent_id, created_at
    FROM messages
    WHERE room_id = ?
    ORDER BY sequence DESC
    LIMIT 5
  `)
};

// ─── WebSocket 连接 ───────────────────────────────────────────────────────
function connect() {
  console.log(`🔌 Connecting to ${WS_URL}...`);
  console.log(`   Agent: ${MY_AGENT_ID}`);
  console.log(`   Room: ${ROOM_ID}`);
  console.log(`   Gateway: ${GATEWAY_URL}/hooks/agent`);
  console.log('');

  ws = new WebSocket(WS_URL);

  ws.on('open', () => {
    console.log('✅ WebSocket connected!');
    reconnectDelay = 3000;
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
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 30000);
  });

  ws.on('error', (err) => {
    console.error('❌ WebSocket error:', err.message);
  });
}



// ─── 消息处理 ─────────────────────────────────────────────────────────────
function handleMessage(msg) {
  const { type, room_id, message, current_turn } = msg;
  
  switch (type) {
    case 'connected':
      console.log(`📋 Connected! Agent: ${MY_AGENT_ID}`);
      console.log(`   Status: Online`);
      updateStatusFile();  // 确保状态为在线
      break;
      
    case 'new_message':
      if (room_id === ROOM_ID && message) {
        const seq = message.sequence || 0;
        const from = message.agent_name || message.agent_id || 'Unknown';
        const content = message.content || '';
        
        console.log(`\n📩 New message from ${from}: ${content.substring(0, 60)}...`);
        
        // 【新增】增强的过滤逻辑：防止无限循环
        // 1. 检查是否是自己的消息（通过 agent_id 和 agent_name）
        const isMyMessage = (
          message.agent_id === MY_AGENT_ID ||
          message.agent_name === MY_NAME_MAP[MY_AGENT_ID]
        );
        
        if (isMyMessage) {
          console.log(`   🚨 Skipping my own message (double-check): ${from}`);
          return;
        }
        
        // 2. 防重入：检查是否已处理过
        if (seq <= lastProcessedSeq) {
          // 检测数据库是否被重置（sequence 重新从 1 开始）
          if (seq === 1 || (seq < lastProcessedSeq && seq <= 10)) {
            console.log(`   🔄 Database reset detected! seq=${seq}, last=${lastProcessedSeq}`);
            console.log(`   Resetting lastProcessedSeq to ${seq - 1}`);
            lastProcessedSeq = seq - 1;  // 重置为比当前 sequence 小 1，这样就能处理当前消息
          } else {
            console.log(`   (skipping seq ${seq}, already processed, last: ${lastProcessedSeq})`);
            return;
          }
        }
        
        // 更新已处理的 sequence
        lastProcessedSeq = seq;
        saveLastSequence(seq);
        
        // 触发 Agent 思考并回复（Agent 自己决定是否继续循环）
        triggerAgent(content, seq);
      }
      break;

    case 'turn_changed':
      if (room_id === ROOM_ID && current_turn === MY_AGENT_ID) {
        console.log(`\n🔄 Turn changed to me! Triggering agent...`);
        triggerAgent('轮到我发言了', undefined);
      }
      break;
  }
}

// ─── 触发 OpenClaw Agent ────────────────────────────────────────────────
async function triggerAgent(contextMessage, seq) {
  // 【新增】循环检测：防止无限循环
  // 如果最近 3 条消息都是来自同一个 agent，停止处理
  try {
    const recentMessages = stmts.getRecentMessages.all(ROOM_ID);
    if (recentMessages && recentMessages.length >= 3) {
      const last3 = recentMessages.slice(0, 3);
      const allSameAgent = last3.every(m => m.agent_id === MY_AGENT_ID);
      if (allSameAgent) {
        console.log(`   🚨 Infinite loop detected! Last 3 messages all from ${MY_AGENT_ID}`);
        console.log(`   Stopping processing to prevent self-triggering.`);
        // 不更新 isProcessing，直接返回
        return;
      }
    }
  } catch (e) {
    // 如果查询失败，继续处理（可能是 schema 问题）
    console.log(`   Warning: Failed to check recent messages: ${e.message}`);
  }

  if (isProcessing) {
    console.log('⏭️  Skip: already processing');
    return;
  }
  
  isProcessing = true;
  
  try {
    const openclawAgentId = AGENT_ID_MAP[MY_AGENT_ID] || MY_AGENT_ID;
    const targetAgentId = TARGET_AGENT_ID_MAP[MY_AGENT_ID];
    const myName = MY_NAME_MAP[MY_AGENT_ID];
    const targetName = TARGET_NAME_MAP[MY_AGENT_ID];
    
    // 构建 prompt（重要规则）
    const prompt = `${myName}：${contextMessage || '轮到你发言了'}

【重要规则】
1. 对话格式：必须使用"名字："开头，如"希米格："或"阿拉蕾："
2. 禁止使用 emoji
3. 不要使用 @提及对方，如需提醒对方，请用名字，如"阿拉蕾，你觉得呢？"或"希米格，我同意你的看法"
4. 【重要】收到对方消息后，必须回复"收到/确认已读"，让对方知道已读
5. 【重要】不要根据"收到"、"好的"、"明白"等词语来判断是否终止讨论！讨论的终止信号来自系统（agents_rooms 表的 no_comments 字段），不是根据消息内容判断
6. 【重要】只要对方还在发送消息，就要积极参与讨论，不要擅自沉默
7. 【重要】如果完全赞成对方的观点，可以选择不回复。但如果是分工协作任务（如"你负责A我负责B"），确认后必须开始干活！
8. 【重要】分工确认后的流程：确认分工 → 开始各自干活 → 干活过程中如有需要帮助则平台上讨论 → 完成后汇报结果
9. 总结报告要尽量详细全面
10. 【发消息规则 - 重要！】讨论过程中的所有回复必须通过 Chat API：
    - 使用 Chat API: POST http://localhost:3210/api/rooms/{room_id}/messages
    - Body: { "agent_id": "你的agent_id", "content": "你的回复内容" }
11. 【发消息规则 - 禁止！】讨论过程中禁止使用 message 工具发 Telegram：
    - 禁止情况：讨论进行中、观点交流、问题回答
    - 允许情况：只有当明确说"讨论结束"或"汇报"时，才允许用 message 工具汇报到 Telegram
    - message 工具参数（仅汇报时使用）: channel: "telegram", to: "-5176287980"（群 ID，不是用户 ID）
12. 【讨论结束标记 - [NO_COMMENTS]】
    - 【使用场景】只有当真正讨论结束时，才在消息末尾添加 "[NO_COMMENTS]"
    - 【判断讨论结束 - 严格遵循】：
      * 双方达成共识（都说"我同意"或"我赞成"）
      * 明确说"讨论结束"、"准备汇报"
      * 已完成分工确认
    - 【收到对方消息包含 [NO_COMMENTS]】：
      * 如果对方消息包含 [NO_COMMENTS]，你也需要在回复末尾添加 [NO_COMMENTS]
      * 当双方都发送了带 [NO_COMMENTS] 的消息时，讨论正式结束
      * 讨论结束后：报告人用 message 工具汇报到 Telegram，非报告人保持沉默

请根据上述规则回复。`;
    
    console.log(`🚀 Triggering OpenClaw Agent: ${openclawAgentId}`);
    console.log(`   Target: ${targetName} (${targetAgentId})`);
    console.log(`   Delivery: false (Agent 自主决定是否 override)`);
    
    const response = await fetch(`${GATEWAY_URL}/hooks/agent`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${WEBHOOK_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        message: prompt,
        agentId: targetAgentId,
        delivery: false,
        channel: CHAT_PLATFORM.channel,
        to: CHAT_PLATFORM.to
      })
    });
    
    if (response.ok) {
      console.log('✅ Webhook triggered successfully!');
      
      // 更新 sequence
      if (seq !== undefined) {
        lastProcessedSeq = seq;
        saveLastSequence(seq);
      }
    } else {
      console.error(`❌ Webhook failed: ${response.status} ${response.statusText}`);
    }
    
  } catch (err) {
    console.error('❌ Error triggering agent:', err.message);
  } finally {
    // 冷却期
    setTimeout(() => {
      isProcessing = false;
    }, 5000);
  }
}

// ─── 启动 ─────────────────────────────────────────────────────────────────
console.log('🚀 WebHook Trigger Agent Starting...');
console.log('='.repeat(50));
console.log('');

connect();

// Graceful shutdown - 更新状态为离线
function shutdown() {
  console.log('\n👋 Shutting down...');
  try {
    let status = { alalei: false, ximige: false };
    if (fs.existsSync(STATUS_FILE)) {
      status = JSON.parse(fs.readFileSync(STATUS_FILE, 'utf8'));
    }
    if (MY_AGENT_ID === 'alalei') {
      status.alalei = false;
    } else if (MY_AGENT_ID === 'ximige') {
      status.ximige = false;
    }
    fs.writeFileSync(STATUS_FILE, JSON.stringify(status, null, 2));
  } catch (e) {
    // ignore
  }
  if (ws) ws.close();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
