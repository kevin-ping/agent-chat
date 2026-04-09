'use strict';
const config = require('../config');
const stmts = require('../db/statements');

const lastMessageTime = new Map();

function checkRateLimit(roomId, agentId) {
  const key = `${roomId}:${agentId}`;
  const lastTime = lastMessageTime.get(key) || 0;
  const now = Date.now();
  if (now - lastTime < config.RATE_LIMIT_MS) {
    return { allowed: false, remaining_ms: config.RATE_LIMIT_MS - (now - lastTime) };
  }
  lastMessageTime.set(key, now);
  return { allowed: true };
}

// agentId is now an INTEGER (agents.id)
function validateTurn(room, agentId) {
  if (room.turn_mode === 'free') return { ok: true };

  if (room.turn_mode === 'strict') {
    if (room.current_turn !== null && room.current_turn !== agentId) {
      return { ok: false, error: `Not your turn. Current turn: ${room.current_turn}` };
    }
    return { ok: true };
  }

  if (room.turn_mode === 'round_robin') {
    const order = JSON.parse(room.turn_order || '[]').map(Number);
    if (order.length === 0) return { ok: true };
    if (room.current_turn !== null && Number(room.current_turn) !== Number(agentId)) {
      return { ok: false, error: `Not your turn. Current turn: ${room.current_turn}` };
    }
    return { ok: true };
  }

  return { ok: true };
}

// agentId and order elements are INTEGER (agents.id)
function advanceTurn(room, agentId) {
  if (room.turn_mode === 'free') return;
  const order = JSON.parse(room.turn_order || '[]').map(Number);
  if (order.length < 2) return;
  const currentIdx = order.indexOf(Number(agentId));
  if (currentIdx === -1) return;
  const nextIdx = (currentIdx + 1) % order.length;
  stmts.updateRoomTurn.run(order[nextIdx], room.id);
}

module.exports = { checkRateLimit, validateTurn, advanceTurn };
