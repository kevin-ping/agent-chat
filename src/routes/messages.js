'use strict';
const router = require('express').Router();
const db = require('../db');
const stmts = require('../db/statements');
const { broadcast, setThinking, clearThinking } = require('../realtime/broadcaster');
const { postMessage } = require('../services/messageService');
const { checkRateLimit, validateTurn } = require('../services/turnService');
const { getAgentsWithStatus } = require('../services/roomService');
const { setAgentNoComments } = require('../services/discussionService');
const config = require('../config');

// POST /api/rooms/:roomId/messages (roomId = integer)
router.post('/:roomId/messages', (req, res) => {
  const roomId = parseInt(req.params.roomId, 10);
  const roomRow = stmts.getRoom.get(roomId);
  if (!roomRow) return res.status(404).json({ error: 'Room not found' });

  const { content, msg_type, metadata, agent_id, no_comments } = req.body;

  // agent_id: accept integer or openclaw string id
  let agentId = null;
  if (agent_id != null) {
    const parsed = parseInt(agent_id, 10);
    if (!isNaN(parsed)) {
      agentId = parsed;
    } else {
      const agentRow = stmts.getAgentByOpenClawId.get(String(agent_id));
      if (agentRow) {
        agentId = agentRow.id;
      } else {
        return res.status(400).json({ error: `Agent not found: ${agent_id}` });
      }
    }
  }

  if (!content) return res.status(400).json({ error: 'content is required' });

  const room = stmts.getRoom.get(roomId);

  if (agentId && room.discussion !== 1) {
    return res.status(403).json({ error: 'Discussion is not active. Call POST /api/rooms/:roomId/discussion/start first.' });
  }

  if (room.turn_mode === 'free' && agentId) {
    const rateCheck = checkRateLimit(roomId, agentId);
    if (!rateCheck.allowed) {
      return res.status(429).json({
        error: `Rate limit: Please wait ${Math.ceil(rateCheck.remaining_ms / 1000)} seconds before sending another message`,
        remaining_ms: rateCheck.remaining_ms
      });
    }
  }

  if (agentId) {
    const membership = stmts.getAgentRoom.get(agentId, roomId);
    if (!membership) {
      return res.status(403).json({ error: 'Agent is not a member of this room' });
    }
  }

  if (agentId) {
    const turnCheck = validateTurn(room, agentId);
    if (!turnCheck.ok) {
      return res.status(403).json({
        error: turnCheck.error,
        current_turn: room.current_turn,
        hint: 'Wait for your turn.'
      });
    }
  }

  try {
    const { message, updatedRoom, noCommentsUpdated } = postMessage(roomId, room, {
      agentId,
      content,
      msgType: msg_type,
      metadata
    });

    if (agentId) {
      clearThinking(roomId, agentId);
      broadcast({ type: 'agent_thinking_done', room_id: roomId, agent_id: agentId });
    }

    broadcast({
      type: 'new_message',
      room_id: roomId,
      message,
      current_turn: updatedRoom.current_turn
    });

    if (updatedRoom.turn_mode === 'round_robin' && updatedRoom.discussion === 1
        && updatedRoom.current_turn !== agentId) {
      const openTopic = stmts.getOpenTopicForRoom.get(roomId);
      broadcast({
        type: 'turn_changed',
        room_id: roomId,
        current_turn: updatedRoom.current_turn,
        discussion_active: true,
        in_confirmation: updatedRoom.in_confirmation,
        topic_id: updatedRoom.topic_id || null,
        topic_title: openTopic?.title || null
      });

      // Show thinking ring for the next agent immediately — reliable in-process broadcast
      if (updatedRoom.current_turn !== null) {
        setThinking(roomId, updatedRoom.current_turn);
        broadcast({ type: 'agent_thinking', room_id: roomId, agent_id: updatedRoom.current_turn });
      }
    }

    if (noCommentsUpdated) {
      broadcast({
        type: 'room_agents_updated',
        room_id: roomId,
        agents: getAgentsWithStatus(roomId)
      });
    }

    // Handle optional no_comments field: update agent agreement status in one API call
    let noCommentsResult = null;
    if (agentId && no_comments !== undefined && no_comments !== null) {
      noCommentsResult = setAgentNoComments(agentId, roomId, no_comments);
      broadcast({ type: 'agents_rooms_updated', room_id: roomId, agents: noCommentsResult.agentsWithStatus });
    }

    if (noCommentsResult?.consensusEvent) {
      const { consensusEvent } = noCommentsResult;
      const freshRoom = stmts.getRoom.get(roomId);
      broadcast({
        ...consensusEvent,
        room_id: roomId,
        agents: noCommentsResult.agentsWithStatus,
        current_turn: freshRoom.current_turn,
        topic_id: consensusEvent.topic_id ?? freshRoom.topic_id ?? null
      });

      // Moderator summary is handled by the Python monitor after detecting discussion_stopped.
    }

    res.status(201).json({ ...message, current_turn: updatedRoom.current_turn });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/rooms/:roomId/messages (roomId = integer)
router.get('/:roomId/messages', (req, res) => {
  const roomId = parseInt(req.params.roomId, 10);
  const roomRow = stmts.getRoom.get(roomId);
  if (!roomRow) return res.status(404).json({ error: 'Room not found' });

  const { limit, offset, after_sequence } = req.query;

  const room = stmts.getRoom.get(roomId);

  const effectiveLimit = Math.min(
    limit ? parseInt(limit) : config.DEFAULT_LIMIT,
    config.MAX_LIMIT
  );

  const messages = after_sequence
    ? stmts.getMessagesAfterSeq.all(roomId, parseInt(after_sequence))
    : stmts.getMessagesPaginated.all(roomId, effectiveLimit, parseInt(offset || 0));

  res.json({
    messages,
    room: { id: room.id, name: room.name, current_turn: room.current_turn, turn_mode: room.turn_mode }
  });
});

// DELETE /api/rooms/:roomId/messages (roomId = integer) — clear all messages in a room
router.delete('/:roomId/messages', (req, res) => {
  const roomId = parseInt(req.params.roomId, 10);
  const roomRow = stmts.getRoom.get(roomId);
  if (!roomRow) return res.status(404).json({ error: 'Room not found' });

  // Stop any active discussion before deleting topics to keep rooms state consistent
  if (roomRow.discussion === 1) {
    stmts.stopRoomDiscussion.run(roomId);
  }

  stmts.deleteRoomMessages.run(roomId);
  stmts.deleteRoomTopics.run(roomId);
  broadcast({ type: 'messages_cleared', room_id: roomId });
  res.json({ ok: true });
});

// DELETE /api/messages/:messageId — single message delete (messageId = integer)
function deleteOne(req, res) {
  const messageId = parseInt(req.params.messageId, 10);
  const message = stmts.getMessageById.get(messageId);
  if (!message) return res.status(404).json({ error: 'Message not found' });

  stmts.deleteMessage.run(message.id);
  broadcast({
    type: 'message_deleted',
    message_id: message.id,
    room_id: message.room_id
  });
  res.json({ ok: true });
}

// DELETE /api/messages — batch delete (ids = array of integer message ids)
function deleteBatch(req, res) {
  const { ids, room_id } = req.body;
  if (!ids || !Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: 'ids array is required' });
  }

  const deleteMany = db.transaction((idList) => {
    const stmt = db.prepare('DELETE FROM messages WHERE id = ?');
    for (const id of idList) stmt.run(id);
  });
  deleteMany(ids);

  broadcast({ type: 'messages_deleted', message_ids: ids, room_id });
  res.json({ ok: true, deleted_count: ids.length });
}

module.exports = router;
module.exports.deleteOne = deleteOne;
module.exports.deleteBatch = deleteBatch;
