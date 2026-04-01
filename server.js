'use strict';
require('dotenv').config();
const http = require('http');
const path = require('path');
const express = require('express');
const os = require('os');

const config = require('./src/config');
// db/index.js auto-runs schema + migrations on first require
require('./src/db');

const { setupWebSocket } = require('./src/realtime/websocket');
const { setupRoutes } = require('./src/routes');
const corsMiddleware = require('./src/middleware/cors');

// ─── Express App ─────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(corsMiddleware);

setupRoutes(app);

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── HTTP + WebSocket Server ─────────────────────────────────────────────────
const server = http.createServer(app);
setupWebSocket(server);

// ─── Start ───────────────────────────────────────────────────────────────────
function getLanIP() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return 'unknown';
}

server.listen(config.PORT, '0.0.0.0', () => {
  const lanIP = getLanIP();
  console.log(`
┌──────────────────────────────────────────────────┐
│  Agent Chat Platform                             │
│  ──────────────────────────────────────────────  │
│                                                  │
│  Local:     http://localhost:${config.PORT}                │
│  LAN:       http://${lanIP}:${config.PORT}    │
│                                                  │
│  API:       http://${lanIP}:${config.PORT}/api │
│  WebSocket: ws://${lanIP}:${config.PORT}/ws    │
│  Database:  ${config.DB_PATH}  │
│                                                  │
│  ➜ Open the LAN URL from any device on           │
│    the same Wi-Fi network                        │
└──────────────────────────────────────────────────┘
  `);
});

// ─── Graceful Shutdown ────────────────────────────────────────────────────────
// Ensures the listening socket is released before process exits so PM2
// can restart without hitting EADDRINUSE on port 3210.
function shutdown(signal) {
  console.log(`\n${signal} received, shutting down gracefully...`);
  server.close(() => {
    console.log('HTTP server closed.');
    process.exit(0);
  });
  // Force-exit after 5 s in case open connections stall the close.
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
