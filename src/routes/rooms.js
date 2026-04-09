'use strict';
const router = require('express').Router();
const db = require('../db');
const stmts = require('../db/statements');
const { broadcast } = require('../realtime/broadcaster');
const { createRoom, getRoomWithAgents, listRoomsWithAgents } = require('../services/roomService');

// POST /api/rooms
router.post('/', (req, res) => {
  const { name, description, turn_mode, agent_ids, password, owner } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });
  try {
    const room = createRoom({
      name,
      description,
      turnMode: turn_mode,
      turnOrder: agent_ids,
      owner: owner || null,
      password
    });
    broadcast({ type: 'room_created', room: getRoomWithAgents(room.id) });
    res.status(201).json(getRoomWithAgents(room.id));
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// GET /api/rooms
router.get('/', (req, res) => {
  res.json(listRoomsWithAgents());
});

// GET /api/rooms/:id (id = integer)
router.get('/:id', (req, res) => {
  const roomId = parseInt(req.params.id, 10);
  const room = getRoomWithAgents(roomId);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  res.json(room);
});

// PATCH /api/rooms/:id (id = integer)
router.patch('/:id', (req, res) => {
  const roomId = parseInt(req.params.id, 10);
  const roomRow = stmts.getRoom.get(roomId);
  if (!roomRow) return res.status(404).json({ error: 'Room not found' });

  const { name, description, turn_mode, agent_ids, owner, room_password, turn_order } = req.body;

  if (room_password !== undefined) {
    stmts.updateRoomPassword.run(room_password, roomId);
  }

  if (owner !== undefined) {
    stmts.updateRoomOwner.run(owner || null, roomId);
  }

  const normalizedTurnOrder = Array.isArray(turn_order)
    ? JSON.stringify(turn_order.map(id => parseInt(id, 10)).filter(id => !isNaN(id)))
    : null;

  stmts.updateRoom.run(
    name || null, description || null, turn_mode || null,
    normalizedTurnOrder, roomId
  );

  if (Array.isArray(agent_ids)) {
    const normalizedAgentIds = agent_ids.map(id => parseInt(id, 10)).filter(id => !isNaN(id));
    const currentAgents = stmts.getRoomAgents.all(roomId).map(a => a.id);
    const toAdd = normalizedAgentIds.filter(id => !currentAgents.includes(id));
    const toRemove = currentAgents.filter(id => !normalizedAgentIds.includes(id));

    db.transaction(() => {
      for (const id of toAdd) stmts.addAgentToRoom.run(roomId, id);
      for (const id of toRemove) stmts.removeAgentFromRoom.run(roomId, id);
      if (!turn_order) {
        stmts.updateRoom.run(null, null, null, JSON.stringify(normalizedAgentIds), roomId);
      }
      const room = stmts.getRoom.get(roomId);
      if (room && toRemove.includes(room.current_turn)) {
        stmts.updateRoomTurn.run(normalizedAgentIds[0] || null, roomId);
      }
    })();
  }

  const room = getRoomWithAgents(roomId);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  broadcast({ type: 'room_updated', room });
  res.json(room);
});

// DELETE /api/rooms/:id (id = integer)
router.delete('/:id', (req, res) => {
  const roomId = parseInt(req.params.id, 10);
  const roomRow = stmts.getRoom.get(roomId);
  if (!roomRow) return res.status(404).json({ error: 'Room not found' });
  stmts.deleteRoomMessages.run(roomId);
  stmts.deleteRoom.run(roomId);
  broadcast({ type: 'room_deleted', room_id: roomId });
  res.json({ ok: true });
});

// POST /api/rooms/:roomId/join (roomId = integer)
router.post('/:roomId/join', (req, res) => {
  const roomId = parseInt(req.params.roomId, 10);
  const roomRow = stmts.getRoom.get(roomId);
  if (!roomRow) return res.status(404).json({ error: 'Room not found' });

  const agentId = parseInt(req.body.agent_id, 10);
  if (!agentId || isNaN(agentId)) return res.status(400).json({ error: 'agent_id is required' });

  const agent = stmts.getAgent.get(agentId);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });

  const existing = stmts.getAgentRoom.get(agentId, roomId);
  if (existing) {
    return res.json({ ok: true, already_member: true, room: getRoomWithAgents(roomId) });
  }

  if (roomRow.room_password) {
    const provided = req.body.room_password || req.headers['x-room-password'] || '';
    if (provided !== roomRow.room_password) {
      return res.status(403).json({ error: 'Invalid room password' });
    }
  }

  stmts.addAgentToRoom.run(roomId, agentId);

  const order = JSON.parse(roomRow.turn_order || '[]');
  if (!order.includes(agentId)) {
    order.push(agentId);
    stmts.updateRoom.run(null, null, null, JSON.stringify(order), roomId);
  }

  const updatedRoom = getRoomWithAgents(roomId);
  broadcast({ type: 'room_updated', room: updatedRoom });
  res.status(201).json({ ok: true, already_member: false, room: updatedRoom });
});

// POST /api/rooms/:roomId/set-turn (roomId = integer)
router.post('/:roomId/set-turn', (req, res) => {
  const roomId = parseInt(req.params.roomId, 10);
  const roomRow = stmts.getRoom.get(roomId);
  if (!roomRow) return res.status(404).json({ error: 'Room not found' });

  let agentIntId = null;
  const { agent_id } = req.body;
  if (agent_id !== null && agent_id !== undefined) {
    agentIntId = typeof agent_id === 'number' ? agent_id : parseInt(agent_id, 10);
    const agentRow = stmts.getAgent.get(agentIntId);
    if (!agentRow) return res.status(404).json({ error: 'Agent not found' });
  }

  stmts.updateRoomTurn.run(agentIntId, roomId);
  broadcast({ type: 'turn_changed', room_id: roomId, current_turn: agentIntId });
  res.json({ ok: true, current_turn: agentIntId });
});

module.exports = router;
