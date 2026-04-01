'use strict';
const router = require('express').Router();
const db = require('../db');
const stmts = require('../db/statements');
const { broadcast } = require('../realtime/broadcaster');
const { postMessage } = require('../services/messageService');
const { checkRateLimit, validateTurn } = require('../services/turnService');
const { getAgentsWithStatus } = require('../services/roomService');
const config = require('../config');

// POST /api/rooms/:roomId/messages (roomId = integer)
router.post('/:roomId/messages', (req, res) => {
  const roomId = parseInt(req.params.roomId, 10);
  const roomRow = stmts.getRoom.get(roomId);
  if (!roomRow) return res.status(404).json({ error: 'Room not found' });

  const { content, msg_type, metadata } = req.body;
  const agentId = req.authAgent?.id;  // integer

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
        hint: room.turn_mode === 'round_robin'
          ? 'Do NOT retry. In round_robin mode, your webhook will be called automatically when it is your turn.'
          : 'Wait for your turn. A moderator or admin must advance the turn.'
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

    broadcast({
      type: 'new_message',
      room_id: roomId,
      message,
      current_turn: updatedRoom.current_turn
    });

    if (noCommentsUpdated) {
      broadcast({
        type: 'room_agents_updated',
        room_id: roomId,
        agents: getAgentsWithStatus(roomId)
      });
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

  stmts.deleteRoomMessages.run(roomId);
  const order = JSON.parse(stmts.getRoom.get(roomId)?.turn_order || '[]');
  if (order.length > 0) stmts.updateRoomTurn.run(order[0], roomId);
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

  // ids are integer message ids
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
