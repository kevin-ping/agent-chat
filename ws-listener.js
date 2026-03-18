#!/usr/bin/env node
/**
 * WebSocket Listener for agent-chat
 * 持续监听 agent-chat 平台的消息，实时通知
 */

const WebSocket = require('ws');

const WS_URL = process.env.WS_URL || 'ws://localhost:3210/ws';
const ROOM_ID = process.env.ROOM_ID || '04d23d77-3a39-4ad6-b6dc-227f4baed930';
const MY_AGENT_ID = process.env.MY_AGENT_ID || 'alalei';

let ws;
let reconnectDelay = 3000;
let isConnected = false;

function connect() {
  console.log(`🔌 Connecting to ${WS_URL}...`);
  ws = new WebSocket(WS_URL);

  ws.on('open', () => {
    console.log('✅ WebSocket connected!');
    isConnected = true;
    reconnectDelay = 3000; // Reset delay on successful connection
  });

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      handleMessage(msg);
    } catch (e) {
      console.error('❌ Parse error:', e.message);
    }
  });

  ws.on('close', () => {
    console.log('🔌 WebSocket disconnected, reconnecting...');
    isConnected = false;
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 30000); // Exponential backoff
  });

  ws.on('error', (err) => {
    console.error('❌ WebSocket error:', err.message);
  });
}

function handleMessage(msg) {
  const { type, room_id, message, current_turn } = msg;
  
  switch (type) {
    case 'connected':
      console.log(`📋 Connected! Agents: ${msg.agents?.length || 0}, Rooms: ${msg.rooms?.length || 0}`);
      break;
      
    case 'new_message':
      if (room_id === ROOM_ID && message) {
        const from = message.agent_name || message.agent_id || 'Unknown';
        console.log(`\n📩 New message from ${from}: ${message.content?.substring(0, 100)}...`);
        
        // Check if it's my turn
        if (current_turn === MY_AGENT_ID) {
          console.log(`🎯 It's my turn! (${MY_AGENT_ID})`);
        }
      }
      break;
      
    case 'turn_changed':
      if (room_id === ROOM_ID) {
        console.log(`\n🔄 Turn changed to: ${current_turn}`);
        if (current_turn === MY_AGENT_ID) {
          console.log(`🎯 🎉 It's my turn now!`);
        }
      }
      break;
      
    case 'agent_created':
    case 'agent_updated':
      console.log(`👤 Agent ${type}:`, msg.agent?.name || msg.agent?.id);
      break;
      
    case 'room_created':
      console.log(`📁 Room created:`, msg.room?.name);
      break;
      
    default:
      // console.log('📨 Received:', type);
  }
}

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log('\n👋 Shutting down...');
  if (ws) ws.close();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n👋 Shutting down...');
  if (ws) ws.close();
  process.exit(0);
});

// Start
console.log('🚀 WebSocket Listener Starting...');
console.log(`   Room: ${ROOM_ID}`);
console.log(`   Agent: ${MY_AGENT_ID}`);
console.log('');
connect();
