'use strict';
const router = require('express').Router();
const stmts = require('../db/statements');
const { broadcast } = require('../realtime/broadcaster');
const { validateTurn } = require('../services/turnService');
const { postMessage } = require('../services/messageService');
const {
  getDiscussionStatus,
  startDiscussion,
  stopDiscussion,
  setAgentNoComments,
  checkTimeout
} = require('../services/discussionService');

// GET /api/rooms/:roomId/discussion-status (roomId = integer)
router.get('/:roomId/discussion-status', (req, res) => {
  const roomId = parseInt(req.params.roomId, 10);
  const roomRow = stmts.getRoom.get(roomId);
  if (!roomRow) return res.status(404).json({ error: 'Room not found' });
  const status = getDiscussionStatus(roomId);
  if (!status) return res.status(404).json({ error: 'Room not found' });
  res.json(status);
});

// POST /api/rooms/:roomId/agents/:agentId/no-comments
// agentId = integer agents.id
router.post('/:roomId/agents/:agentId/no-comments', (req, res) => {
  const roomId = parseInt(req.params.roomId, 10);
  const roomRow = stmts.getRoom.get(roomId);
  if (!roomRow) return res.status(404).json({ error: 'Room not found' });

  const agentId = parseInt(req.params.agentId, 10);
  const agentRow = stmts.getAgent.get(agentId);
  if (!agentRow) return res.status(404).json({ error: 'Agent not found' });

  const { no_comments } = req.body;
  const { agentsWithStatus, consensusEvent } = setAgentNoComments(agentRow.id, roomId, no_comments);

  broadcast({ type: 'agents_rooms_updated', room_id: roomId, agents: agentsWithStatus });

  if (consensusEvent) {
    broadcast({ ...consensusEvent, room_id: roomId, agents: agentsWithStatus });
  }

  res.json({ success: true, message: 'Agent no_comments status updated' });
});

// POST /api/rooms/:roomId/discussion/start (roomId = integer)
router.post('/:roomId/discussion/start', (req, res) => {
  const roomId = parseInt(req.params.roomId, 10);
  const room = stmts.getRoom.get(roomId);
  if (!room) return res.status(404).json({ error: 'Room not found' });

  // Guard: reject if a discussion is already active
  if (room.discussion === 1) {
    return res.status(409).json({
      error: 'A discussion is already active in this room.',
      hint: 'Call POST /api/rooms/:roomId/discussion/stop first, or wait for the current discussion to end.'
    });
  }

  const agentId = req.authAgent?.id;

  // Turn check for round_robin and strict modes.
  // Skip if current_turn is null (first-ever discussion, no prior turn set).
  if (agentId && room.turn_mode !== 'free' && room.current_turn !== null) {
    const turnCheck = validateTurn(room, agentId);
    if (!turnCheck.ok) {
      return res.status(403).json({
        error: 'Not your turn. You cannot start the discussion now.',
        current_turn: room.current_turn,
        hint: 'Do NOT retry. Your webhook will be called automatically when it is your turn to start.'
      });
    }
  }

  const { moderator_id, timeout_seconds, topic, content } = req.body;
  // moderator_id: accept integer agent.id (optional)
  let moderatorIntId = null;
  if (moderator_id != null) {
    moderatorIntId = typeof moderator_id === 'number' ? moderator_id : parseInt(moderator_id, 10);
    const agentRow = stmts.getAgent.get(moderatorIntId);
    if (!agentRow) return res.status(404).json({ error: 'Agent not found' });
  }

  const result = startDiscussion(roomId, moderatorIntId, timeout_seconds, topic || null);
  broadcast({
    type: 'discussion_started',
    room_id: roomId,
    moderator_id: moderatorIntId,
    agents: result.agentsWithStatus,
    topic: result.topic || null
  });

  // Optionally post the first message atomically if content is provided.
  // This advances the turn and fires the webhook to the next agent immediately.
  let firstMessage = null;
  if (content && agentId) {
    try {
      const freshRoom = stmts.getRoom.get(roomId);
      const { message, updatedRoom } = postMessage(roomId, freshRoom, {
        agentId,
        content,
        msgType: 'message',
        metadata: {}
      });
      firstMessage = message;
      broadcast({
        type: 'new_message',
        room_id: roomId,
        message,
        current_turn: updatedRoom.current_turn
      });
    } catch (e) {
      // Discussion started successfully — return partial success with error note
      return res.json({
        success: result.success,
        message: result.message,
        roomStatus: result.roomStatus,
        topic: result.topic || null,
        first_message: null,
        warning: `Discussion started but first message failed: ${e.message}`
      });
    }
  }

  res.json({
    success: result.success,
    message: result.message,
    roomStatus: result.roomStatus,
    topic: result.topic || null,
    first_message: firstMessage || null
  });
});

// POST /api/rooms/:roomId/discussion/stop (roomId = integer)
router.post('/:roomId/discussion/stop', (req, res) => {
  const roomId = parseInt(req.params.roomId, 10);
  const roomRow = stmts.getRoom.get(roomId);
  if (!roomRow) return res.status(404).json({ error: 'Room not found' });

  const { reason, send_alert } = req.body;
  const result = stopDiscussion(roomId, reason);
  broadcast({ type: 'discussion_stopped', room_id: roomId, reason, agents: result.agentsWithStatus });

  const response = { success: result.success, message: result.message, reason: result.reason };
  if (send_alert) response.alert_sent = true;
  res.json(response);
});

// GET /api/rooms/:roomId/timeout-check (roomId = integer)
router.get('/:roomId/timeout-check', (req, res) => {
  const roomId = parseInt(req.params.roomId, 10);
  const roomRow = stmts.getRoom.get(roomId);
  if (!roomRow) return res.status(404).json({ error: 'Room not found' });
  const result = checkTimeout(roomId);
  if (!result) return res.status(404).json({ error: 'Room not found' });
  res.json(result);
});

// GET /api/rooms/:roomId/topics (roomId = integer)
router.get('/:roomId/topics', (req, res) => {
  const roomId = parseInt(req.params.roomId, 10);
  const roomRow = stmts.getRoom.get(roomId);
  if (!roomRow) return res.status(404).json({ error: 'Room not found' });
  const topics = stmts.listTopics.all(roomId);
  res.json({ topics });
});

// GET /api/rooms/:roomId/topics/:topicId/messages (roomId = integer, topicId = integer)
router.get('/:roomId/topics/:topicId/messages', (req, res) => {
  const roomId = parseInt(req.params.roomId, 10);
  const roomRow = stmts.getRoom.get(roomId);
  if (!roomRow) return res.status(404).json({ error: 'Room not found' });
  const topicId = parseInt(req.params.topicId, 10);
  const topic = stmts.getTopic.get(topicId);
  if (!topic || topic.room_id !== roomId) return res.status(404).json({ error: 'Topic not found' });
  const messages = stmts.getTopicMessages.all(topic.id);
  res.json({ topic, messages });
});

// DELETE /api/rooms/:roomId/topics/:topicId (roomId = integer, topicId = integer)
router.delete('/:roomId/topics/:topicId', (req, res) => {
  const roomId = parseInt(req.params.roomId, 10);
  const roomRow = stmts.getRoom.get(roomId);
  if (!roomRow) return res.status(404).json({ error: 'Room not found' });
  const topicId = parseInt(req.params.topicId, 10);
  const topic = stmts.getTopic.get(topicId);
  if (!topic || topic.room_id !== roomId) return res.status(404).json({ error: 'Topic not found' });

  // Delete all messages associated with this topic first
  stmts.deleteTopicMessages.run(topic.id);
  // Then delete the topic
  stmts.deleteTopic.run(topic.id);

  // Broadcast deletion event
  broadcast({
    type: 'topic_deleted',
    room_id: roomId,
    topic_id: topic.id
  });

  res.json({ success: true, message: 'Topic and associated messages deleted' });
});

// GET /api/rooms/:roomId/topics/:topicId/export?format=md|html|pdf
router.get('/:roomId/topics/:topicId/export', (req, res) => {
  const roomId = parseInt(req.params.roomId, 10);
  const roomRow = stmts.getRoom.get(roomId);
  if (!roomRow) return res.status(404).json({ error: 'Room not found' });
  const topicId = parseInt(req.params.topicId, 10);
  const topic = stmts.getTopic.get(topicId);
  if (!topic || topic.room_id !== roomId) return res.status(404).json({ error: 'Topic not found' });

  const format = (req.query.format || 'md').toLowerCase();
  const messages = stmts.getTopicMessages.all(topic.id);

  if (format === 'md') {
    const lines = [
      `# ${topic.title}`,
      ``,
      `**Room:** ${roomRow.name}  `,
      `**Status:** ${topic.status}  `,
      `**Created:** ${topic.created_at}${topic.closed_at ? `  \n**Closed:** ${topic.closed_at}` : ''}`,
      ``,
      `---`,
      ``
    ];
    for (const m of messages) {
      const agent = m.agent_name || 'System';
      lines.push(`**${agent}** *(#${m.sequence})*`);
      lines.push(``);
      lines.push(m.content);
      lines.push(``);
      lines.push(`---`);
      lines.push(``);
    }
    const filename = `topic-${topic.id}.md`;
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.send(lines.join('\n'));
  }

  if (format === 'html' || format === 'pdf') {
    const mdLines = [];
    for (const m of messages) {
      const agent = m.agent_name || 'System';
      mdLines.push(`**${agent}** *(#${m.sequence})*\n\n${m.content}\n\n---\n`);
    }
    const mdContent = mdLines.join('\n');

    const metaBlock = [
      `<p style="color:#888;font-size:13px;margin-bottom:4px"><strong>Room:</strong> ${esc(roomRow.name)}</p>`,
      `<p style="color:#888;font-size:13px;margin-bottom:4px"><strong>Status:</strong> ${esc(topic.status)}</p>`,
      `<p style="color:#888;font-size:13px;margin-bottom:16px"><strong>Created:</strong> ${esc(topic.created_at)}${topic.closed_at ? ` &nbsp;|&nbsp; <strong>Closed:</strong> ${esc(topic.closed_at)}` : ''}</p>`,
    ].join('\n');

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(topic.title)}</title>
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github.min.css">
<script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/markdown-it/14.1.0/markdown-it.min.js"></script>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 860px; margin: 40px auto; padding: 0 24px; color: #1a1a1a; line-height: 1.6; }
  h1 { border-bottom: 2px solid #e5e7eb; padding-bottom: 12px; }
  hr { border: none; border-top: 1px solid #e5e7eb; margin: 20px 0; }
  pre { background: #f6f8fa; border-radius: 6px; padding: 12px; overflow-x: auto; }
  code { font-family: 'SFMono-Regular', Consolas, monospace; font-size: 13px; }
  blockquote { border-left: 4px solid #d1d5db; margin: 0; padding-left: 16px; color: #6b7280; }
</style>
</head>
<body>
<h1>${esc(topic.title)}</h1>
${metaBlock}
<div id="content"></div>
<script>
const md = window.markdownit({ html: false, linkify: true, typographer: true, highlight: function(str, lang) {
  if (lang && hljs.getLanguage(lang)) {
    try { return hljs.highlight(str, { language: lang }).value; } catch {}
  }
  return '';
}});
const raw = ${JSON.stringify(mdContent)};
document.getElementById('content').innerHTML = md.render(raw);
</script>
</body>
</html>`;

    const filename = `topic-${topic.id}.html`;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
    return res.send(html);
  }

  res.status(400).json({ error: 'format must be md, html, or pdf' });
});

function esc(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

module.exports = router;
