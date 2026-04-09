'use strict';

const clients = new Set();
// key: `${roomId}:${agentId}`, value: timestamp (ms)
const thinkingAgents = new Map();

function broadcast(data) {
  const msg = JSON.stringify(data);
  for (const ws of clients) {
    if (ws.readyState === 1) ws.send(msg);
  }
}

function setThinking(roomId, agentId) {
  thinkingAgents.set(`${roomId}:${agentId}`, Date.now());
}

function clearThinking(roomId, agentId) {
  thinkingAgents.delete(`${roomId}:${agentId}`);
}

function clearRoomThinking(roomId) {
  for (const key of thinkingAgents.keys()) {
    if (key.startsWith(`${roomId}:`)) thinkingAgents.delete(key);
  }
}

function isThinking(roomId, agentId) {
  return thinkingAgents.has(`${roomId}:${agentId}`);
}

module.exports = { clients, broadcast, setThinking, clearThinking, clearRoomThinking, isThinking };
