'use strict';
const db = require('../db');
const stmts = require('../db/statements');
const config = require('../config');

function getAgentsWithStatus(roomId) {
  const agents = stmts.getRoomAgents.all(roomId);
  return agents.map(a => {
    const agentRoom = stmts.getAgentRoom.get(a.id, roomId);
    return { ...a, no_comments: agentRoom ? agentRoom.no_comments : 0 };
  });
}

function createRoom({ name, description, turnMode, turnOrder, owner, password }) {
  const totalRooms = stmts.countAllRooms.get();
  if (totalRooms.count >= config.MAX_ROOMS) {
    const err = new Error(`Platform room limit reached (max: ${config.MAX_ROOMS})`);
    err.status = 403;
    throw err;
  }
  if (owner) {
    const serverRooms = stmts.countRoomsByOwner.get(owner);
    if (serverRooms.count >= config.ROOM_PER_SERVER) {
      const err = new Error(`Room limit reached for this OpenClaw server: ${serverRooms.count}/${config.ROOM_PER_SERVER}`);
      err.status = 403;
      throw err;
    }
  }

  const mode = turnMode || 'round_robin';
  // turnOrder contains integer agent ids
  const order = turnOrder || [];

  const create = db.transaction(() => {
    const result = stmts.createRoom.run(name, description || '', mode, JSON.stringify(order), owner || null, password || '');
    const roomId = result.lastInsertRowid;

    for (const agentId of order) {
      stmts.addAgentToRoom.run(roomId, agentId);
    }
    if (order.length > 0 && mode !== 'free') {
      stmts.updateRoomTurn.run(order[0], roomId);
    }
    return roomId;
  });

  const roomId = create();
  return stmts.getRoom.get(roomId);
}

function getRoomWithAgents(roomId) {
  const room = stmts.getRoom.get(roomId);
  if (!room) return null;
  const { room_password, ...safeRoom } = room;
  return { ...safeRoom, has_password: !!room_password, agents: getAgentsWithStatus(room.id) };
}

function listRoomsWithAgents() {
  const rooms = stmts.listRooms.all();
  return rooms.map(room => {
    const { room_password, ...safeRoom } = room;
    return { ...safeRoom, has_password: !!room_password, agents: getAgentsWithStatus(room.id) };
  });
}

module.exports = { createRoom, getRoomWithAgents, listRoomsWithAgents, getAgentsWithStatus };
