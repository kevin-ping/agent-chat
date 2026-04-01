'use strict';
const { notifyAgent } = require('./webhookNotifier');
const { notifyWaiters } = require('./longPoll');

const clients = new Set();

function broadcast(data) {
  const msg = JSON.stringify(data);
  for (const ws of clients) {
    if (ws.readyState === 1) ws.send(msg);
  }

  if (data.current_turn) {
    notifyAgent(data.current_turn, data);
    notifyWaiters(data.room_id, data.current_turn);
  }
}

module.exports = { clients, broadcast };
