'use strict';
const fs = require('fs');
const path = require('path');
const router = require('express').Router();
const stmts = require('../db/statements');
const { broadcast } = require('../realtime/broadcaster');
const {
  getDiscussionStatus,
  startDiscussion,
  stopDiscussion,
  setAgentNoComments
} = require('../services/discussionService');
// openclawRunner kept for retrigger endpoint only; moderator summary is handled by Python monitor.
const {
  triggerAgent,
  buildFirstSpeakerPrompt
} = require('../lib/openclawRunner');

// POST /api/rooms/:roomId/discussion/retrigger (roomId = integer)
// Manually re-trigger the current_turn agent — use when a discussion is stalled.
router.post('/:roomId/discussion/retrigger', (req, res) => {
  const roomId = parseInt(req.params.roomId, 10);
  const room = stmts.getRoom.get(roomId);
  if (!room) return res.status(404).json({ error: 'Room not found' });

  if (room.discussion !== 1) {
    return res.status(400).json({ error: 'No active discussion in this room.' });
  }

  if (!room.current_turn) {
    return res.status(400).json({ error: 'No current_turn set for this room.' });
  }

  const agent = stmts.getAgent.get(room.current_turn);
  if (!agent) {
    return res.status(404).json({ error: `Current turn agent (id=${room.current_turn}) not found.` });
  }

  const openTopic = stmts.getOpenTopicForRoom.get(roomId);
  const prompt = buildFirstSpeakerPrompt(room, openTopic, agent);
  triggerAgent(agent, roomId, prompt, {
    trigger: 'manual_retrigger',
    reason: 'stall_recovery'
  });

  res.json({
    success: true,
    message: `Re-triggered agent "${agent.name}" (id=${agent.id})`,
    current_turn: room.current_turn
  });
});

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
    const freshRoomForConsensus = stmts.getRoom.get(roomId);
    broadcast({
      ...consensusEvent,
      room_id: roomId,
      agents: agentsWithStatus,
      current_turn: freshRoomForConsensus.current_turn,
      topic_id: consensusEvent.topic_id ?? freshRoomForConsensus.topic_id ?? null
    });

    // Moderator summary is handled by the Python monitor after detecting discussion_stopped.
  }

  res.json({ success: true, message: 'Agent no_comments status updated' });
});

// POST /api/rooms/:roomId/discussion/start (roomId = integer)
// Only the agent matching current_turn may call this (if current_turn is set).
// If current_turn is NULL (first discussion), any room member may call.
// current_turn and moderator_id are randomly assigned at start; Python monitor drives the first turn.
router.post('/:roomId/discussion/start', (req, res) => {
  const roomId = parseInt(req.params.roomId, 10);
  const room = stmts.getRoom.get(roomId);
  if (!room) return res.status(404).json({ error: 'Room not found' });

  if (room.discussion === 1) {
    return res.status(409).json({
      error: 'A discussion is already active in this room.',
      hint: 'Call POST /api/rooms/:roomId/discussion/stop first, or wait for the current discussion to end.'
    });
  }

  if (room.topic_id !== null) {
    return res.status(409).json({
      error: 'Room already has an active topic linked to a discussion.',
      hint: 'Call POST /api/rooms/:roomId/discussion/stop first.'
    });
  }

  const { topic, agent_id } = req.body;

  if (!topic || typeof topic !== 'string' || !topic.trim()) {
    return res.status(400).json({ error: 'topic (non-empty string) is required to start a discussion.' });
  }

  const agentId = agent_id != null ? parseInt(agent_id, 10) : null;

  // Caller validation: if current_turn is set, only that agent may start.
  if (room.current_turn !== null && agentId !== null) {
    if (Number(agentId) !== Number(room.current_turn)) {
      return res.status(403).json({
        error: 'Only the current-turn agent may start a new discussion.',
        current_turn: room.current_turn,
        hint: 'Wait for app instructions — the system will notify you when it is your turn.'
      });
    }
  }

  // If agentId provided, verify agent is a room member.
  if (agentId !== null) {
    const membership = stmts.getAgentRoom.get(agentId, roomId);
    if (!membership) {
      return res.status(403).json({ error: 'Agent is not a member of this room.' });
    }
  }

  // Close any leftover open topics to avoid getOpenTopicForRoom returning a stale one
  const leftoverTopics = stmts.listTopics.all(roomId).filter(t => t.status === 'open');
  for (const t of leftoverTopics) {
    stmts.closeTopic.run(t.id);
  }

  const insertResult = stmts.insertTopic.run(roomId, topic.trim());
  // Use lastInsertRowid directly instead of re-querying, to avoid snapshot race conditions
  const newTopic = stmts.getTopic.get(insertResult.lastInsertRowid);

  // startDiscussion internally randomises current_turn and moderator_id.
  const result = startDiscussion(roomId, newTopic.id);
  const freshRoomAfterStart = stmts.getRoom.get(roomId);
  broadcast({
    type: 'discussion_started',
    room_id: roomId,
    moderator_id: freshRoomAfterStart.moderator_id,
    agents: result.agentsWithStatus,
    topic: result.topic,
    current_turn: freshRoomAfterStart.current_turn
  });

  // Python monitor detects discussion=1 and drives the first turn automatically.

  res.json({
    success: result.success,
    message: result.message,
    roomStatus: {
      ...result.roomStatus,
      moderator_id: freshRoomAfterStart.moderator_id,
      current_turn: freshRoomAfterStart.current_turn
    },
    topic: result.topic
  });
});

// POST /api/rooms/:roomId/discussion/resume (roomId = integer)
router.post('/:roomId/discussion/resume', (req, res) => {
  const roomId = parseInt(req.params.roomId, 10);
  const room = stmts.getRoom.get(roomId);
  if (!room) return res.status(404).json({ error: 'Room not found' });

  if (room.discussion === 1) {
    return res.status(409).json({
      error: 'A discussion is already active in this room.',
      hint: 'Call POST /api/rooms/:roomId/discussion/stop first.'
    });
  }

  if (room.topic_id !== null) {
    return res.status(409).json({
      error: 'Room already has an active topic linked to a discussion.',
      hint: 'Call POST /api/rooms/:roomId/discussion/stop first.'
    });
  }

  const { topic_id, agent_id } = req.body;

  const topicId = parseInt(topic_id, 10);
  if (!topic_id || isNaN(topicId)) {
    return res.status(400).json({ error: 'topic_id (integer) is required to resume a discussion.' });
  }

  const topic = stmts.getTopic.get(topicId);
  if (!topic || topic.room_id !== roomId) {
    return res.status(404).json({ error: 'Topic not found in this room.' });
  }

  if (topic.status === 'closed') {
    return res.status(409).json({
      error: 'Topic is closed. Reopen it before resuming.',
      hint: `Call POST /api/rooms/${roomId}/topics/${topicId}/reopen first.`,
      topic_id: topicId
    });
  }

  const agentId = agent_id != null ? parseInt(agent_id, 10) : null;

  // Caller validation: if current_turn is set, only that agent may resume.
  if (room.current_turn !== null && agentId !== null) {
    if (Number(agentId) !== Number(room.current_turn)) {
      return res.status(403).json({
        error: 'Only the current-turn agent may resume the discussion.',
        current_turn: room.current_turn,
        hint: 'Wait for app instructions — the system will notify you when it is your turn.'
      });
    }
  }

  // startDiscussion internally randomises current_turn and moderator_id.
  const result = startDiscussion(roomId, topicId);
  const freshRoomAfterResume = stmts.getRoom.get(roomId);
  broadcast({
    type: 'discussion_started',
    room_id: roomId,
    moderator_id: freshRoomAfterResume.moderator_id,
    agents: result.agentsWithStatus,
    topic: result.topic,
    current_turn: freshRoomAfterResume.current_turn
  });

  // Python monitor detects discussion=1 and drives the first turn automatically.

  res.json({
    success: result.success,
    message: 'Discussion resumed',
    roomStatus: {
      ...result.roomStatus,
      moderator_id: freshRoomAfterResume.moderator_id,
      current_turn: freshRoomAfterResume.current_turn
    },
    topic: result.topic
  });
});

// POST /api/rooms/:roomId/discussion/stop (roomId = integer)
router.post('/:roomId/discussion/stop', (req, res) => {
  const roomId = parseInt(req.params.roomId, 10);
  const roomRow = stmts.getRoom.get(roomId);
  if (!roomRow) return res.status(404).json({ error: 'Room not found' });

  const { reason } = req.body;
  const result = stopDiscussion(roomId, reason);
  const freshRoom = stmts.getRoom.get(roomId);
  broadcast({
    type: 'discussion_stopped',
    room_id: roomId,
    reason,
    agents: result.agentsWithStatus,
    moderator_id: freshRoom.moderator_id,
    current_turn: freshRoom.current_turn,
    topic_id: result.topicId || null
  });

  // Moderator summary is handled by the Python monitor after detecting discussion_stopped.

  res.json({ success: result.success, message: result.message, reason: result.reason });
});

// GET /api/rooms/:roomId/topics (roomId = integer)
router.get('/:roomId/topics', (req, res) => {
  const roomId = parseInt(req.params.roomId, 10);
  const roomRow = stmts.getRoom.get(roomId);
  if (!roomRow) return res.status(404).json({ error: 'Room not found' });
  const topics = stmts.listTopics.all(roomId);
  res.json({ topics });
});

// POST /api/rooms/:roomId/topics/:topicId/close
// Called by the moderator after writing the discussion summary.
router.post('/:roomId/topics/:topicId/close', (req, res) => {
  const roomId = parseInt(req.params.roomId, 10);
  const room = stmts.getRoom.get(roomId);
  if (!room) return res.status(404).json({ error: 'Room not found' });

  const topicId = parseInt(req.params.topicId, 10);
  const topic = stmts.getTopic.get(topicId);
  if (!topic || topic.room_id !== roomId)
    return res.status(404).json({ error: 'Topic not found in this room.' });

  if (topic.status === 'closed')
    return res.json({ success: true, message: 'Topic already closed.', topic });

  stmts.closeTopic.run(topicId);
  const updatedTopic = stmts.getTopic.get(topicId);
  broadcast({ type: 'topic_closed', room_id: roomId, topic: updatedTopic });
  res.json({ success: true, message: 'Topic closed.', topic: updatedTopic });
});

// POST /api/rooms/:roomId/topics/:topicId/reopen
router.post('/:roomId/topics/:topicId/reopen', (req, res) => {
  const roomId = parseInt(req.params.roomId, 10);
  const room = stmts.getRoom.get(roomId);
  if (!room) return res.status(404).json({ error: 'Room not found' });

  const topicId = parseInt(req.params.topicId, 10);
  const topic = stmts.getTopic.get(topicId);
  if (!topic || topic.room_id !== roomId) {
    return res.status(404).json({ error: 'Topic not found in this room.' });
  }

  if (topic.status === 'open') {
    return res.json({ success: true, message: 'Topic is already open.', topic });
  }

  if (room.discussion === 1) {
    return res.status(409).json({
      error: 'Cannot reopen a topic while a discussion is active.',
      hint: 'Call POST /api/rooms/:roomId/discussion/stop first, then reopen.'
    });
  }

  stmts.reopenTopic.run(topicId);
  const updatedTopic = stmts.getTopic.get(topicId);
  broadcast({ type: 'topic_reopened', room_id: roomId, topic: updatedTopic });
  res.json({ success: true, message: 'Topic reopened.', topic: updatedTopic });
});

// GET /api/rooms/:roomId/topics/:topicId/messages
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

// DELETE /api/rooms/:roomId/topics/:topicId
router.delete('/:roomId/topics/:topicId', (req, res) => {
  const roomId = parseInt(req.params.roomId, 10);
  const roomRow = stmts.getRoom.get(roomId);
  if (!roomRow) return res.status(404).json({ error: 'Room not found' });
  const topicId = parseInt(req.params.topicId, 10);
  const topic = stmts.getTopic.get(topicId);
  if (!topic || topic.room_id !== roomId) return res.status(404).json({ error: 'Topic not found' });

  stmts.deleteTopicMessages.run(topic.id);
  stmts.deleteTopic.run(topic.id);
  broadcast({ type: 'topic_deleted', room_id: roomId, topic_id: topic.id });
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
    const filename = `${topic.title.replace(/[^a-z0-9\-_ ]/gi, '_')}.md`;
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.send(lines.join('\n'));
  }

  if (format === 'html' || format === 'pdf') {
    const statusColor = topic.status === 'open' ? '#16a34a' : topic.status === 'closed' ? '#6b7280' : '#d97706';
    const statusBg   = topic.status === 'open' ? '#dcfce7' : topic.status === 'closed' ? '#f3f4f6' : '#fef9c3';

    const avatarCache = {};
    const toDataUri = (avatarUrl) => {
      if (!avatarUrl) return null;
      if (avatarCache[avatarUrl]) return avatarCache[avatarUrl];
      try {
        const filePath = path.join(__dirname, '..', '..', 'public', avatarUrl.replace(/^\//, ''));
        const buf = fs.readFileSync(filePath);
        const ext = path.extname(filePath).toLowerCase().replace('.', '');
        const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg'
                   : ext === 'png'  ? 'image/png'
                   : ext === 'gif'  ? 'image/gif'
                   : ext === 'webp' ? 'image/webp'
                   : 'image/jpeg';
        const dataUri = `data:${mime};base64,${buf.toString('base64')}`;
        avatarCache[avatarUrl] = dataUri;
        return dataUri;
      } catch (_) { return null; }
    };

    const messagesHtml = messages.map(m => {
      const agentName  = m.agent_name || 'System';
      const initial    = agentName.charAt(0).toUpperCase();
      const color      = m.color || '#6366f1';
      const bgColor    = color + '28';
      const body       = mdToHtml(m.content || '');
      const dataUri    = toDataUri(m.avatar_url);
      const avatarHtml = dataUri
        ? `<img src="${dataUri}" class="msg-avatar-img" alt="${esc(agentName)}">`
        : `<div class="msg-avatar-init" style="background:${bgColor};color:${color}">${initial}</div>`;
      return `<div class="message">
  <div class="msg-avatar">${avatarHtml}</div>
  <div class="msg-body">
    <div class="msg-header">
      <span class="msg-name" style="color:${color}">${esc(agentName)}</span>
      <span class="msg-time">${esc(m.created_at)}</span>
      <span class="msg-seq">#${m.sequence}</span>
    </div>
    <div class="msg-content">${body}</div>
  </div>
</div>`;
    }).join('\n');

    const safeTitle = topic.title.replace(/[^a-z0-9\-_ ]/gi, '_');
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(topic.title)}</title>
<style>
  *, *::before, *::after { box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 780px; margin: 48px auto; padding: 0 24px 64px; color: #111827; line-height: 1.6; background: #fff; }
  .export-header { margin-bottom: 32px; padding-bottom: 24px; border-bottom: 1px solid #e5e7eb; }
  .export-title { font-size: 22px; font-weight: 700; margin: 0 0 12px; color: #111827; }
  .export-meta { display: flex; flex-wrap: wrap; gap: 10px 20px; align-items: center; }
  .meta-item { font-size: 13px; color: #6b7280; }
  .meta-item strong { color: #374151; font-weight: 600; }
  .status-badge { display: inline-block; padding: 2px 10px; border-radius: 20px; font-size: 12px; font-weight: 600; background: ${statusBg}; color: ${statusColor}; }
  .message-list { display: flex; flex-direction: column; gap: 2px; }
  .message { display: flex; gap: 14px; align-items: flex-start; padding: 14px 16px; border-radius: 8px; transition: background 0.1s; }
  .message:hover { background: #f9fafb; }
  .msg-avatar { flex-shrink: 0; width: 40px; height: 40px; position: relative; }
  .msg-avatar-img { width: 40px; height: 40px; border-radius: 50%; object-fit: cover; display: block; }
  .msg-avatar-init { width: 40px; height: 40px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 15px; font-weight: 700; }
  .msg-body { flex: 1; min-width: 0; }
  .msg-header { display: flex; align-items: baseline; gap: 8px; margin-bottom: 6px; flex-wrap: wrap; }
  .msg-name { font-size: 14px; font-weight: 700; }
  .msg-time { font-size: 12px; color: #9ca3af; }
  .msg-seq { font-size: 11px; color: #d1d5db; background: #f3f4f6; padding: 1px 6px; border-radius: 4px; font-variant-numeric: tabular-nums; }
  .msg-content { font-size: 14px; color: #374151; line-height: 1.7; }
  .msg-content p { margin: 0 0 8px; } .msg-content p:last-child { margin-bottom: 0; }
  .msg-content h1,.msg-content h2,.msg-content h3 { margin: 14px 0 6px; font-weight: 700; color: #111827; }
  .msg-content ul,.msg-content ol { margin: 6px 0; padding-left: 20px; }
  .msg-content li { margin-bottom: 3px; }
  .msg-content pre { background: #f6f8fa; border: 1px solid #e5e7eb; border-radius: 6px; padding: 14px 16px; overflow-x: auto; margin: 10px 0; }
  .msg-content code { font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', monospace; font-size: 13px; background: #f3f4f6; padding: 2px 5px; border-radius: 4px; color: #e53e3e; }
  .msg-content pre code { background: none; padding: 0; color: #374151; font-size: 13px; }
  .msg-content blockquote { border-left: 3px solid #d1d5db; margin: 10px 0; padding: 4px 0 4px 16px; color: #6b7280; }
  .msg-content a { color: #2563eb; text-decoration: none; } .msg-content a:hover { text-decoration: underline; }
  .msg-content hr { border: none; border-top: 1px solid #e5e7eb; margin: 12px 0; }
  .msg-content table { border-collapse: collapse; width: 100%; margin: 10px 0; font-size: 13px; }
  .msg-content th,.msg-content td { border: 1px solid #e5e7eb; padding: 7px 12px; text-align: left; }
  .msg-content th { background: #f9fafb; font-weight: 600; }
</style>
</head>
<body>
<div class="export-header">
  <h1 class="export-title">${esc(topic.title)}</h1>
  <div class="export-meta">
    <span class="meta-item"><strong>Room:</strong> ${esc(roomRow.name)}</span>
    <span class="status-badge">${esc(topic.status)}</span>
    <span class="meta-item"><strong>Created:</strong> ${esc(topic.created_at)}</span>
    ${topic.closed_at ? `<span class="meta-item"><strong>Closed:</strong> ${esc(topic.closed_at)}</span>` : ''}
    <span class="meta-item">${messages.length} message${messages.length !== 1 ? 's' : ''}</span>
  </div>
</div>
<div class="message-list">
${messagesHtml}
</div>
</body>
</html>`;

    const filename = `${safeTitle}.html`;
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

function mdToHtml(md) {
  const lines = String(md).split('\n');
  const out = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.startsWith('```')) {
      const lang = esc(line.slice(3).trim());
      const codeLines = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) {
        codeLines.push(esc(lines[i]));
        i++;
      }
      out.push(`<pre><code${lang ? ` class="language-${lang}"` : ''}>${codeLines.join('\n')}</code></pre>`);
      i++;
      continue;
    }

    const h3 = line.match(/^### (.+)/);
    if (h3) { out.push(`<h3>${inlineMd(h3[1])}</h3>`); i++; continue; }
    const h2 = line.match(/^## (.+)/);
    if (h2) { out.push(`<h2>${inlineMd(h2[1])}</h2>`); i++; continue; }
    const h1 = line.match(/^# (.+)/);
    if (h1) { out.push(`<h1>${inlineMd(h1[1])}</h1>`); i++; continue; }

    if (/^---+$/.test(line.trim())) { out.push('<hr>'); i++; continue; }

    if (line.startsWith('> ')) {
      out.push(`<blockquote>${inlineMd(line.slice(2))}</blockquote>`);
      i++; continue;
    }

    if (line.trim() === '') { out.push(''); i++; continue; }

    out.push(`<p>${inlineMd(line)}</p>`);
    i++;
  }

  return out.join('\n');
}

function inlineMd(str) {
  return esc(str)
    .replace(/\*\*\*([^*]+)\*\*\*/g, '<strong><em>$1</em></strong>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
}

module.exports = router;
