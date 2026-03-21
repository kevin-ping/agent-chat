/**
 * Agent 讨论流程逻辑
 * 处理收到 session_send 后的响应
 */

const API_BASE = 'http://localhost:3210';
const ROOM_ID = '493c8ac8-d743-40ea-a9b4-d630e60200d9';

// Agent 配置
const AGENTS = {
  alalei: {
    id: 'alalei',
    api_key: 'alalei_key_123',
    name: '阿拉蕾',
    other: 'ximige'
  },
  ximige: {
    id: 'ximige',
    api_key: 'ximige_key_456',
    name: '希米格',
    other: 'alalei'
  }
};

// 重试配置
const MAX_RETRIES = 10;
const RETRY_DELAY_MS = 5000;
const COOLDOWN_MS = 2000;

/**
 * 解析 session_send 消息
 * 格式: start_msg_id:current_max_id
 */
function parseSessionMessage(message) {
  const parts = message.split(':');
  if (parts.length >= 2) {
    return {
      start_msg_id: parts[0],
      current_max_id: parts[1]
    };
  }
  return null;
}

/**
 * 获取当前 agent 配置
 */
function getMyConfig() {
  // 从环境变量或硬编码获取当前 agent
  const agentId = process.env.MY_AGENT_ID || 'ximige';
  return AGENTS[agentId];
}

/**
 * 获取数据库中最大的 message id (通过 sequence)
 */
async function getMaxSequence(roomId) {
  const response = await fetch(`${API_BASE}/api/rooms/${roomId}/messages?limit=1`);
  const data = await response.json();
  if (data.messages && data.messages.length > 0) {
    return data.messages[0].sequence;
  }
  return 0;
}

/**
 * 获取对话上下文
 */
async function getContext(roomId, agentId, startMsgId, lastN = 10) {
  let url = `${API_BASE}/api/rooms/${roomId}/context?agent_id=${agentId}&last_n=${lastN}`;
  if (startMsgId) {
    url += `&start_msg_id=${startMsgId}`;
  }
  const response = await fetch(url);
  return await response.json();
}

/**
 * 发送消息到 chat 平台
 */
async function postMessage(roomId, agentId, apiKey, content) {
  const response = await fetch(`${API_BASE}/api/rooms/${roomId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      agent_id: agentId,
      api_key: apiKey,
      content: content
    })
  });
  return await response.json();
}

/**
 * 等待指定毫秒
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 主处理函数
 */
async function handleSessionSend(message) {
  const myConfig = getMyConfig();
  console.log(`[${myConfig.name}] 收到 session_send: ${message}`);

  // 1. 解析 message_id
  const parsed = parseSessionMessage(message);
  if (!parsed) {
    console.error('无法解析 message 格式');
    return;
  }

  const { start_msg_id, current_max_id } = parsed;
  console.log(`  起始消息: ${start_msg_id}, 当前最大: ${current_max_id}`);

  // 2. 检查 freshness (重试逻辑)
  let lastError;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const dbMaxSeq = await getMaxSequence(ROOM_ID);
      console.log(`  尝试 ${attempt}: 数据库最大 sequence = ${dbMaxSeq}`);

      // 如果 current_max_id > 数据库最大 sequence，说明是 fresh
      const currentMaxNum = parseInt(current_max_id);
      if (currentMaxNum > dbMaxSeq) {
        console.log('  ✅ 消息是 fresh 的，开始处理...');

        // 3. 获取上下文
        const context = await getContext(ROOM_ID, myConfig.id, start_msg_id, 10);
        console.log(`  上下文获取成功，共 ${context.transcript?.length || 0} 条消息`);

        // 4. 生成回复 (这里需要 AI 介入，这里先用占位符)
        const replyContent = await generateReply(context, myConfig);

        // 5. 等待 cooldown
        console.log(`  ⏳ 等待 ${COOLDOWN_MS}ms cooldown...`);
        await sleep(COOLDOWN_MS);

        // 6. 发送回复到 chat 平台
        const msgResult = await postMessage(ROOM_ID, myConfig.id, myConfig.api_key, replyContent);
        console.log(`  ✅ 消息已发送: ${msgResult.id}`);

        // 7. 构造新的 message_id 格式并 session_send 给对方
        const newMaxSeq = msgResult.sequence;
        const newMessageId = `${start_msg_id}:${newMaxSeq}`;
        
        // 这里需要调用 sessions_send 工具通知对方
        // 具体实现由 agent 自己调用
        console.log(`  📤 应该发送 session_send 给 ${myConfig.other}: ${newMessageId}`);
        
        return { success: true, messageId: msgResult.id, newSessionId: newMessageId };
      } else {
        console.log('  ⏭️ 消息是 stale 的，跳过处理');
        return { success: true, skipped: true, reason: 'stale' };
      }
    } catch (err) {
      lastError = err;
      console.error(`  ❌ 尝试 ${attempt} 失败: ${err.message}`);
      if (attempt < MAX_RETRIES) {
        console.log(`  ⏳ 等待 ${RETRY_DELAY_MS}ms 后重试...`);
        await sleep(RETRY_DELAY_MS);
      }
    }
  }

  console.error(`  💥 所有重试都失败: ${lastError?.message}`);
  return { success: false, error: lastError?.message };
}

/**
 * 生成回复 (需要 AI 介入)
 * 这里应该调用 AI 模型生成智能回复
 */
async function generateReply(context, myConfig) {
  // TODO: 调用 AI 模型生成回复
  // 暂时返回占位符
  return `[${myConfig.name}] 收到消息，正在思考中...`;
}

// 导出处理函数
module.exports = { handleSessionSend, parseSessionMessage, getContext, postMessage };
