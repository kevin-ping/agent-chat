'use strict';
const stmts = require('../db/statements');

const waitingClients = new Map();

function addWaiter(roomId, agentId, res, timeoutSec) {
  const key = `${roomId}:${agentId}`;

  const timer = setTimeout(() => {
    removeWaiter(key, res);
    const room = stmts.getRoom.get(roomId);
    res.json({
      your_turn: false,
      room_id: roomId,
      current_turn: room ? room.current_turn : null,
      timeout: true
    });
  }, timeoutSec * 1000);

  if (!waitingClients.has(key)) waitingClients.set(key, []);
  waitingClients.get(key).push({ res, timer });

  return key;
}

function removeWaiter(key, res) {
  const waiters = waitingClients.get(key);
  if (!waiters) return;
  const idx = waiters.findIndex(w => w.res === res);
  if (idx !== -1) {
    clearTimeout(waiters[idx].timer);
    waiters.splice(idx, 1);
  }
  if (waiters.length === 0) waitingClients.delete(key);
}

function notifyWaiters(roomId, currentTurn) {
  const key = `${roomId}:${currentTurn}`;
  const waiters = waitingClients.get(key);
  if (!waiters || waiters.length === 0) return;

  const context = stmts.getMessages.all(roomId);
  const payload = {
    your_turn: true,
    room_id: roomId,
    current_turn: currentTurn,
    last_message: context.length > 0 ? context[context.length - 1] : null,
    total_messages: context.length
  };

  for (const { res, timer } of waiters) {
    clearTimeout(timer);
    try { res.json(payload); } catch (e) {}
  }
  waitingClients.delete(key);
}

module.exports = { addWaiter, removeWaiter, notifyWaiters };
