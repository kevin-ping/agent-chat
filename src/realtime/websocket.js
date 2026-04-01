'use strict';
const { WebSocketServer } = require('ws');
const { clients } = require('./broadcaster');
const stmts = require('../db/statements');
const { toPublicAgents } = require('../lib/agentView');
const { listRoomsWithAgents } = require('../services/roomService');

function setupWebSocket(server) {
  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws, req) => {
    clients.add(ws);
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
    console.log(`[ws] client connected (${ip}) — total: ${clients.size}`);

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

  return wss;
}

module.exports = { setupWebSocket };
