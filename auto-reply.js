#!/usr/bin/env node
/**
 * Auto-Reply Agent for agent-chat
 * 
 * Features:
 * 1. Listens to WebSocket for new messages
 * 2. Auto-generates replies using AI
 * 3. Respects end conditions:
 *    - Keyword: "讨论结束", "完毕", "就这些"
 *    - Time limit: 15 minutes
 *    - Round limit: N rounds
 *    - External: Kevin says stop
 */

const WebSocket = require('ws');

const WS_URL = process.env.WS_URL || 'ws://localhost:3210/ws';
const ROOM_ID = process.env.ROOM_ID || '04d23d77-3a39-4ad6-b6dc-227f4baed930';
const MY_AGENT_ID = process.env.MY_AGENT_ID || 'alalei';

// Configuration - from environment variables
const CONFIG = {
  maxTimeMinutes: parseInt(process.env.MAX_TIME_MINUTES) || 15,
  maxRounds: parseInt(process.env.MAX_ROUNDS) || 50,
  endKeywords: (process.env.END_KEYWORDS || '讨论结束,完毕,就这些,就这样,结束吧,stop,done,finish').split(',').map(k => k.trim()),
  checkIntervalMs: 3000,
};

// State
let ws;
let conversationStartTime = null;
let roundCount = 0;
let isActive = true;
let lastMessageSeq = 0;
let lastReplyTime = 0;
const REPLY_COOLDOWN_MS = 3000; // 3 seconds cooldown between replies

function connect() {
  console.log(`🔌 Connecting to ${WS_URL}...`);
  ws = new WebSocket(WS_URL);

  ws.on('open', () => {
    console.log('✅ Auto-reply agent connected!');
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
    setTimeout(connect, 3000);
  });

  ws.on('error', (err) => {
    console.error('❌ WebSocket error:', err.message);
  });
}

function handleMessage(msg) {
  const { type, room_id, message, current_turn } = msg;
  
  if (type === 'connected') {
    console.log(`📋 Connected! Room: ${ROOM_ID}, Agent: ${MY_AGENT_ID}`);
    conversationStartTime = Date.now();
    return;
  }
  
  if (type === 'new_message' && room_id === ROOM_ID && message) {
    const seq = message.sequence || 0;
    const from = message.agent_name || message.agent_id || 'Unknown';
    const content = message.content || '';
    
    console.log(`\n📩 New message from ${from}: ${content.substring(0, 50)}...`);
    
    // Skip if it's my own message
    if (message.agent_id === MY_AGENT_ID) {
      console.log('   (skipping my own message)');
      return;
    }
    
    // Check end conditions
    if (checkEndConditions(content)) {
      console.log('🛑 End condition detected! Stopping auto-reply.');
      isActive = false;
      return;
    }
    
    // Update last message seq
    if (seq > lastMessageSeq) {
      lastMessageSeq = seq;
      roundCount++;
      
      // Check round limit
      if (roundCount > CONFIG.maxRounds) {
        console.log('🛑 Max rounds reached! Stopping auto-reply.');
        isActive = false;
        return;
      }
      
      // Generate auto reply (no turn check in free mode)
      if (isActive) {
        generateReply(content, from);
      }
    }
  }
}

function checkEndConditions(content) {
  // Check keywords
  for (const keyword of CONFIG.endKeywords) {
    if (content.includes(keyword)) {
      console.log(`🛑 End keyword detected: ${keyword}`);
      return true;
    }
  }
  
  // Check time limit
  if (conversationStartTime) {
    const elapsed = (Date.now() - conversationStartTime) / 1000 / 60; // minutes
    if (elapsed > CONFIG.maxTimeMinutes) {
      console.log(`🛑 Time limit reached: ${elapsed.toFixed(1)} minutes`);
      return true;
    }
  }
  
  return false;
}

function generateReply(originalContent, from) {
  // Check cooldown - wait 3 seconds between replies
  const now = Date.now();
  if (now - lastReplyTime < REPLY_COOLDOWN_MS) {
    console.log(`⏳ Cooldown: waiting ${REPLY_COOLDOWN_MS - (now - lastReplyTime)}ms before next reply...`);
    setTimeout(() => generateReply(originalContent, from), REPLY_COOLDOWN_MS - (now - lastReplyTime));
    return;
  }
  
  lastReplyTime = now;
  
  const replies = [
    `收到！感谢 ${from} 的消息～ 🐧`,
    `明白啦！让我想想... 🤔`,
    `好的！我同意你的观点！👍`,
    `收到！我来分析一下... 📝`,
  ];
  
  const reply = replies[Math.floor(Math.random() * replies.length)];
  
  console.log(`🤖 Auto-reply: ${reply}`);
  
  // Send the reply via API
  const axios = require('axios');
  axios.post(`http://localhost:3210/api/rooms/${ROOM_ID}/messages`, {
    agent_id: MY_AGENT_ID,
    content: reply
  }).then(res => {
    console.log('✅ Reply sent!');
  }).catch(err => {
    console.error('❌ Failed to send reply:', err.message);
  });
}

// Start
console.log('🚀 Auto-Reply Agent Starting...');
console.log(`   Room: ${ROOM_ID}`);
console.log(`   Agent: ${MY_AGENT_ID}`);
console.log(`   Max Time: ${CONFIG.maxTimeMinutes} minutes`);
console.log(`   Max Rounds: ${CONFIG.maxRounds}`);
console.log(`   End Keywords: ${CONFIG.endKeywords.join(', ')}`);
console.log('');

connect();

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n👋 Shutting down auto-reply agent...');
  if (ws) ws.close();
  process.exit(0);
});
