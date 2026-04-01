#!/usr/bin/env node
/**
 * Room-level Trigger for agent-chat
 *
 * 功能：
 * 1. 启动时从数据库加载所有房间，每 60 秒刷新一次（自动感知新房间）
 * 2. 监听 WebSocket，收到消息后检查对应 room 的 current_turn
 * 3. 从数据库获取最近消息构建完整上下文
 * 4. 通过 OpenClaw Gateway 触发对应 agent
 *
 * 每个房间状态独立（isProcessing / lastProcessedSeq），不相互阻塞。
 * DB schema v3: rooms/agents/messages use INTEGER id only; no guid column.
 * WebSocket events use integer id as room_id.
 */

require('dotenv').config();
const { createWsClient } = require('../lib/wsClient');
const queries = require('../lib/dbReader');
const { shouldStopDiscussion } = require('../lib/discussionGuard');

// ─── 配置 ─────────────────────────────────────────────────────────────────
const BASE_URL = process.env.BASE_URL || 'http://localhost:3210';
const WS_URL = process.env.WS_URL || `${BASE_URL.replace(/^http/, 'ws')}/ws`;
const WEBHOOK_TOKEN = process.env.WEBHOOK_TOKEN || 'my-secret-token';
const AGENT_LOG_DETAIL = process.env.AGENT_LOG_DETAIL === '1';

// ─── 日志工具 ──────────────────────────────────────────────────────────────
function ts() {
  return new Date().toISOString().replace('T', ' ').substring(0, 19);
}
function log(roomLabel, ...args) {
  const prefix = roomLabel ? `[${ts()}][${String(roomLabel).substring(0, 8)}]` : `[${ts()}]`;
  console.log(prefix, ...args);
}
function logErr(roomLabel, ...args) {
  const prefix = roomLabel ? `[${ts()}][${String(roomLabel).substring(0, 8)}]` : `[${ts()}]`;
  console.error(prefix, ...args);
}

// ─── 每房间状态 ────────────────────────────────────────────────────────────
// roomStates: Map<intId, { isProcessing, lastProcessedSeq }>
const roomStates = new Map();

function getOrInitState(intId) {
  if (!roomStates.has(intId)) {
    roomStates.set(intId, { isProcessing: false, lastProcessedSeq: -1 });
  }
  return roomStates.get(intId);
}

// ─── 房间加载 ──────────────────────────────────────────────────────────────
function loadRooms() {
  try {
    const rooms = queries.listRooms.all(); // { id: integer, ... }
    for (const room of rooms) {
      const { max_seq } = queries.getMaxSeq.get(room.id);

      if (!roomStates.has(room.id)) {
        roomStates.set(room.id, { isProcessing: false, lastProcessedSeq: max_seq });
        log(null, `registered room=${room.name} id=${room.id} lastProcessedSeq=${max_seq}`);
      } else {
        const state = roomStates.get(room.id);
        if (max_seq < state.lastProcessedSeq) {
          log(null, `sync room=${room.name} lastProcessedSeq ${state.lastProcessedSeq}→${max_seq} (drift)`);
          state.lastProcessedSeq = max_seq;
        }
      }
    }
    log(null, `rooms loaded: ${roomStates.size} total`);
  } catch (e) {
    logErr(null, `err loading rooms: ${e.message}`);
  }
}

// ─── 消息处理 ─────────────────────────────────────────────────────────────
async function handleMessage(msg) {
  // WS events use integer id as room_id
  const { type, room_id: roomId, message } = msg;

  switch (type) {
    case 'connected':
      log(null, `ws connected, monitoring ${roomStates.size} rooms`);
      break;

    case 'new_message': {
      if (!roomId || !message) break;
      const intId = roomId; // already integer

      const state = getOrInitState(intId);
      const seq = message.sequence || 0;
      const from = message.agent_name || message.agent_id || 'Unknown';
      const content = message.content || '';

      log(intId, `new_message from=${from} seq=${seq}: ${content.substring(0, 80)}`);

      if (seq <= state.lastProcessedSeq) {
        log(intId, `skip seq=${seq} (already processed, last=${state.lastProcessedSeq})`);
        break;
      }

      state.lastProcessedSeq = seq;

      if (shouldStopDiscussion(intId, queries)) {
        log(intId, `skip: discussion not active`);
        break;
      }

      await triggerNextAgent(intId, state, content, seq);
      break;
    }
  }
}

// ─── 触发下一个 Agent ────────────────────────────────────────────────────
async function triggerNextAgent(intRoomId, state, contextMessage, seq) {
  if (state.isProcessing) {
    log(intRoomId, `skip: already processing seq=${seq}`);
    return;
  }

  state.isProcessing = true;

  try {
    const room = queries.getRoom.get(intRoomId);     // query by integer id
    if (!room) { logErr(intRoomId, `err: room not found`); return; }

    const agents = queries.getRoomAgents.all(intRoomId);
    if (!agents || agents.length === 0) { logErr(intRoomId, `err: no agents in room`); return; }

    // current_turn is now INTEGER (agents.id)
    const nextAgentIntId = room.current_turn;
    const nextAgent = agents.find(a => a.id === nextAgentIntId);
    if (!nextAgent) {
      logErr(intRoomId, `err: current_turn agent id=${nextAgentIntId} not found in room (turn_mode=${room.turn_mode})`);
      return;
    }

    let hookUrl = nextAgent.agent_hook_url;
    if (!hookUrl) {
      logErr(intRoomId, `err: agent "${nextAgent.name}" (${nextAgent.agent_id}) has no hook_url`);
      return;
    }
    if (!hookUrl.endsWith('/hooks/agent')) {
      hookUrl = hookUrl.replace(/\/$/, '') + '/hooks/agent';
    }

    log(intRoomId, `--- TRIGGER START ---`);
    log(intRoomId, `  room   : ${room.name || intRoomId}`);
    log(intRoomId, `  agent  : ${nextAgent.name} (${nextAgent.agent_id})`);
    log(intRoomId, `  hookUrl: ${hookUrl}`);

    const otherAgents = agents.filter(a => a.id !== nextAgentIntId).map(a => a.name).join(', ');
    const limit = agents.length;
    const recentMessages = queries.getRecentMessages.all(intRoomId, limit);
    const [latestRow, ...historyRows] = recentMessages;
    const historyAsc = historyRows.reverse();
    const latestText = latestRow
      ? `message #${latestRow.sequence}: ${latestRow.agent_name}: ${latestRow.content}`
      : '(none)';
    const historyText = historyAsc.length > 0
      ? historyAsc.map(m => `message #${m.sequence}: ${m.agent_name}: ${m.content}`).join('\n')
      : '(no prior history)';

    // Use integer id in API URLs — the HTTP API routes expect integer id
    const roomId = intRoomId;
    const agentId = nextAgent.id;

    const confirmationHeader = room.in_confirmation === 1
      ? `【最终确认阶段】
所有参与者在上一轮均已达成初步共识。
请最后回顾一遍完整的讨论内容：
- 如果你同意所有结论，请直接说"同意"，简短即可，不要带额外评论，然后传给下一位。
- 如果你有任何新的疑虑或不同意见，请明确说明你的异议。

`
      : '';

    const prompt = `${confirmationHeader}⚠️ MANDATORY EXECUTION REQUIRED ⚠️
Before completing this turn, you MUST call the exec tool TWICE — once to post your reply, once to update your status. Generating text alone is NOT sufficient. Both exec calls must be made.

[Task]
You are ${nextAgent.name}, participating in a discussion with ${otherAgents}. Review the conversation below and provide your response or suggestion.

[Latest Message]
${latestText}

[Conversation History]
${historyText}

[Expression Rules]
1. Do NOT use first-person pronouns "I" or "we".
   - Bad: I think... / We feel...
   - Good: ${nextAgent.name} thinks... / ${nextAgent.name} feels...

2. Do not prefix your reply with your own name. Start directly with your content.
   - Bad: ${nextAgent.name}: Sure, I agree
   - Good: Sure, ${nextAgent.name} agrees

3. To address a specific agent, use the @ symbol.
   - @AgentName, {message for that agent}
   - If addressing multiple agents, @ each one separately.

[Steps — Execute in Order]

⚠️ CRITICAL — IF ANY API CALL RETURNS HTTP 403:
Stop immediately. Do NOT retry. Do NOT call the API again.
A 403 "Not your turn" means the system has not yet advanced to your turn.
The system will send a new trigger to your webhook automatically when it is your turn.
Retrying out of turn will always fail and wastes tokens.

STEP 1 — Form your response.
Review the conversation and compose your reply. You may use tools or skills to support your analysis.

STEP 2 — EXECUTE NOW: Post your reply to the Chat API.
Replace YOUR_REPLY_TEXT with your actual reply text, then call exec with this exact command:

exec tool → curl -X POST ${BASE_URL}/api/rooms/${roomId}/messages \\
  -H "Content-Type: application/json" \\
  -H "x-api-key: ${nextAgent.api_key}" \\
  -d '{ "content": "YOUR_REPLY_TEXT" }'

If the response is HTTP 403, stop here — do not proceed to Step 3. Your webhook will be re-triggered when it is your turn.

STEP 3 — EXECUTE NOW: Update your no_comments status.
Set no_comments = true only if you agree with ALL points raised. Set no_comments = false if you have any doubt, disagreement, or addition. Then call exec with this exact command:

exec tool → curl -X POST ${BASE_URL}/api/rooms/${roomId}/agents/${agentId}/no-comments \\
  -H "Content-Type: application/json" \\
  -H "x-api-key: ${nextAgent.api_key}" \\
  -d '{ "no_comments": true }'

⚠️ REMINDER: This turn is NOT complete until both exec tool calls above have been made. Do NOT stop after generating text.`;

    const token = nextAgent.webhook_token || WEBHOOK_TOKEN;
    log(intRoomId, `  seq    : ${seq}`);
    log(intRoomId, `  prompt : ${prompt.substring(0, 120).replace(/\n/g, ' ')}...`);

    const fetchBody = JSON.stringify({
      agentId: nextAgent.agent_id,
      delivery: true,
      channel: nextAgent.channel_type,
      to: nextAgent.channel_id,
      message: prompt
    });

    if (AGENT_LOG_DETAIL) {
      log(intRoomId, `  [curl] curl -X POST '${hookUrl}' -H 'Authorization: Bearer ***' -H 'Content-Type: application/json' -d '${fetchBody}'`);
    }

    const response = await fetch(hookUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: fetchBody
    });

    const responseText = await response.text();
    if (response.ok) {
      log(intRoomId, `  result : HTTP ${response.status} OK — ${responseText.substring(0, 120)}`);
    } else {
      logErr(intRoomId, `  result : HTTP ${response.status} FAIL — ${responseText.substring(0, 200)}`);
    }
    log(intRoomId, `--- TRIGGER END ---`);

  } catch (e) {
    logErr(intRoomId, `err during trigger: ${e.message}`);
  } finally {
    state.isProcessing = false;
  }
}

// ─── 启动 ─────────────────────────────────────────────────────────────────
loadRooms();
setInterval(loadRooms, 60_000);

log(null, `room-trigger start (multi-room mode), ws=${WS_URL}`);

createWsClient({
  url: WS_URL,
  onMessage: handleMessage,
  onConnect: () => log(null, `ws connected, monitoring ${roomStates.size} rooms`)
});
