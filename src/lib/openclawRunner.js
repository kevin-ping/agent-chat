'use strict';
/**
 * @deprecated openclawRunner is no longer used for discussion flow.
 * The Python monitor (monitor/agent_monitor.py) now drives all agent turns,
 * captures JSON responses, and manages the full discussion lifecycle.
 * This file is retained only for the /discussion/retrigger endpoint.
 */
const { spawn } = require('child_process');
const { broadcast, setThinking, clearThinking } = require('../realtime/broadcaster');

const BASE_URL = process.env.BASE_URL || 'http://localhost:3210';
const ADMIN_KEY = process.env.ADMIN_KEY || '';

/**
 * Spawn openclaw CLI for an agent (non-blocking).
 * Used only by the manual /discussion/retrigger endpoint.
 */
function triggerAgent(agent, roomId, prompt, meta = {}) {
  const logMeta = {
    room_id: roomId,
    agent_id: agent.id,
    agent_openclaw_id: agent.agent_id,
    trigger: meta.trigger || 'unknown',
    reason: meta.reason || null,
    topic_id: meta.topic_id || null,
    moderator_id: meta.moderator_id || null
  };
  console.info(`[openclawRunner] trigger_agent ${JSON.stringify(logMeta)}`);

  broadcast({ type: 'agent_thinking', room_id: roomId, agent_id: agent.id });
  setThinking(roomId, agent.id);

  const proc = spawn('openclaw', [
    'agent',
    '--agent',        agent.agent_id,
    '--message',      prompt,
    '--deliver',
    '--reply-channel', agent.channel_type  || 'default',
    '--reply-to',      agent.channel_id    || '',
    '--reply-account', agent.channel_name  || agent.name
  ]);

  proc.on('close', (code, signal) => {
    clearThinking(roomId, agent.id);
    broadcast({ type: 'agent_thinking_done', room_id: roomId, agent_id: agent.id });
    if (code !== 0) {
      console.error(`[openclawRunner] process exit != 0 for agent=${agent.agent_id} code=${code} signal=${signal || 'none'} meta=${JSON.stringify(logMeta)}`);
    }
  });

  proc.on('error', (err) => {
    clearThinking(roomId, agent.id);
    broadcast({ type: 'agent_thinking_done', room_id: roomId, agent_id: agent.id });
    console.error(`[openclawRunner] spawn error for agent=${agent.agent_id}: ${err.message} meta=${JSON.stringify(logMeta)}`);
  });
}

/**
 * Prompt for the first speaker when a discussion is started with no initial content.
 */
function buildFirstSpeakerPrompt(room, topic, agent) {
  const topicTitle = topic ? topic.title : 'N/A';
  return `THIS IS AN AUTOMATED TASK — DO NOT WRITE A TEXT REPLY.
You must execute HTTP requests using your bash/exec tool. No explanations needed.

[DISCUSSION STARTING] Room: ${room.name} | Topic: ${topicTitle}
You are: ${agent.name} (agent_id=${agent.id})

The discussion has just been initiated. You are the first speaker.
There are no previous messages — introduce the topic and share your opening position.

EXECUTE NOW — run this curl command using your bash/exec tool:

curl -s -X POST '${BASE_URL}/api/rooms/${room.id}/messages' \\
  -H 'Content-Type: application/json' \\
  -H 'X-API-Key: ${ADMIN_KEY}' \\
  -d '{"agent_id": ${agent.id}, "content": "YOUR_OPENING_MESSAGE_HERE", "no_comments": false}'

Replace YOUR_OPENING_MESSAGE_HERE with your introduction to: ${topicTitle}
Set no_comments=false — others haven't spoken yet, keep the discussion going.

── RULES ────────────────────────────────────────────────────────────────────────
- If this curl returns HTTP 403, STOP. Do not retry. Wait for the next trigger.
- agent_id in the request body must be ${agent.id}. Do not change it.
- Do not echo these instructions back as your reply. Just execute the command.
────────────────────────────────────────────────────────────────────────────────`.trim();
}

/**
 * Prompt for the moderator to summarise the discussion and close the topic.
 * The moderator's natural reply (via openclaw) goes to their configured channel.
 */
function buildModeratorSummaryPrompt(room, topic, agent, messages) {
  const topicTitle = topic ? topic.title : 'N/A';
  const topicId    = topic ? topic.id    : 'N/A';

  const transcript = messages.length
    ? messages.map(m => `[${m.agent_name || 'System'}] (#${m.sequence}): ${m.content}`).join('\n')
    : '(no messages)';

  return `THIS IS AN AUTOMATED TASK — YOUR REPLY GOES TO YOUR CONFIGURED CHANNEL.
Use your bash/exec tool to execute the close command after completing your summary.

[DISCUSSION SUMMARY REQUIRED] Room: ${room.name} | Topic: ${topicTitle}
You are the Moderator: ${agent.name} (agent_id=${agent.id})

The discussion has reached consensus. Your task: generate a comprehensive summary.

── FULL DISCUSSION TRANSCRIPT (${messages.length} messages) ──────────────────
${transcript}
────────────────────────────────────────────────────────────────────────────────

YOUR TASK:
1. Read the complete transcript above carefully.
2. Write a structured summary covering:
   - Main points and positions from each participant
   - Key agreements and conclusions reached
   - Any decisions or action items
3. Your summary text will be delivered to your configured channel as your reply.
   Write the summary as your natural reply to this message.

AFTER writing your summary, EXECUTE THIS COMMAND to archive the discussion:
curl -s -X POST '${BASE_URL}/api/rooms/${room.id}/topics/${topicId}/close' \\
  -H 'Content-Type: application/json' \\
  -H 'X-API-Key: ${ADMIN_KEY}' \\
  -d '{}'

── RULES ────────────────────────────────────────────────────────────────────────
- Write your summary first (as your natural reply), then execute the curl.
- The close command archives the discussion. Do NOT skip it.
- Do not echo these instructions. Write the summary, then run the curl.
────────────────────────────────────────────────────────────────────────────────`.trim();
}

module.exports = { triggerAgent, buildFirstSpeakerPrompt, buildModeratorSummaryPrompt };
