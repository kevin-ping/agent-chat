'use strict';
const { WebSocketServer } = require('ws');
const { clients } = require('./broadcaster');
const stmts = require('../db/statements');
const { toPublicAgents } = require('../lib/agentView');
const { listRoomsWithAgents } = require('../services/roomService');

const HEARTBEAT_INTERVAL = 30_000;

function setupWebSocket(server) {
  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws, req) => {
    ws.isAlive = true;
    clients.add(ws);
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
    console.log(`[ws] client connected (${ip}) — total: ${clients.size}`);

    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('close', () => {
      clients.delete(ws);
      console.log(`[ws] client disconnected — total: ${clients.size}`);
    });
    ws.on('error', (err) => {
      clients.delete(ws);
      console.error(`[ws] client error: ${err.message}`);
    });

    ws.send(JSON.stringify({
      type: 'connected',
      rooms: listRoomsWithAgents(),
      agents: toPublicAgents(stmts.listAgents.all())
    }));
  });

  // Ping all clients every 30s; terminate those that never responded to the last ping
  const heartbeatTimer = setInterval(() => {
    for (const ws of clients) {
      if (!ws.isAlive) {
        console.warn('[ws] heartbeat timeout — terminating stale client');
        clients.delete(ws);
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, HEARTBEAT_INTERVAL);

  wss.on('close', () => clearInterval(heartbeatTimer));

  return wss;
}

module.exports = { setupWebSocket };
