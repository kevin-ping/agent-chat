const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const Database = require('better-sqlite3');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const multer = require('multer');
const fs = require('fs');

// ─── Config ─────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3210;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'chat.db');

// ─── Rate Limiter for free mode ─────────────────────────────────────────────
// Prevent agents from sending messages too quickly in free mode
const lastMessageTime = new Map(); // key: "roomId:agentId" -> timestamp
const RATE_LIMIT_MS = 3000; // 3 seconds cooldown

function checkRateLimit(roomId, agentId) {
  const key = `${roomId}:${agentId}`;
  const lastTime = lastMessageTime.get(key) || 0;
  const now = Date.now();
  
  if (now - lastTime < RATE_LIMIT_MS) {
    return {
      allowed: false,
      remaining_ms: RATE_LIMIT_MS - (now - lastTime)
    };
  }
  
  lastMessageTime.set(key, now);
  return { allowed: true };
}

// ─── Database Setup ─────────────────────────────────────────────────────────
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS rooms (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT DEFAULT '',
    turn_mode TEXT DEFAULT 'free',  -- 'free' | 'strict' | 'round_robin'
    current_turn TEXT DEFAULT NULL,  -- agent_id whose turn it is
    turn_order TEXT DEFAULT '[]',    -- JSON array of agent_ids for round_robin
    created_at DATETIME DEFAULT (datetime('now')),
    updated_at DATETIME DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    avatar_emoji TEXT DEFAULT '🤖',
    color TEXT DEFAULT '#6366f1',
    avatar_url TEXT DEFAULT '',
    created_at DATETIME DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL,
    agent_id TEXT,               -- NULL for system messages
    content TEXT NOT NULL,
    sequence INTEGER NOT NULL,   -- global sequence within room for ordering
    msg_type TEXT DEFAULT 'message',  -- 'message' | 'system' | 'error'
    metadata TEXT DEFAULT '{}',  -- JSON blob for extra data
    created_at DATETIME DEFAULT (datetime('now')),
    FOREIGN KEY (room_id) REFERENCES rooms(id),
    FOREIGN KEY (agent_id) REFERENCES agents(id)
  );

  CREATE INDEX IF NOT EXISTS idx_messages_room_seq ON messages(room_id, sequence);
  CREATE INDEX IF NOT EXISTS idx_messages_room_time ON messages(room_id, created_at);

  CREATE TABLE IF NOT EXISTS room_agents (
    room_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    joined_at DATETIME DEFAULT (datetime('now')),
    PRIMARY KEY (room_id, agent_id),
    FOREIGN KEY (room_id) REFERENCES rooms(id),
    FOREIGN KEY (agent_id) REFERENCES agents(id)
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at DATETIME DEFAULT (datetime('now'))
  );
`);

// ─── Database Migrations ─────────────────────────────────────────────────────
// Auto-add missing columns for backward compatibility
function runMigrations() {
  const migrations = [
    { table: 'agents', column: 'avatar_url', type: 'TEXT DEFAULT ""' },
    // Add more migrations here as needed
  ];

  for (const mig of migrations) {
    try {
      const result = db.prepare(`SELECT ${mig.column} FROM ${mig.table} LIMIT 1`).get();
    } catch (e) {
      if (e.message.includes('no such column')) {
        console.log(`[Migration] Adding column ${mig.column} to ${mig.table}...`);
        db.exec(`ALTER TABLE ${mig.table} ADD COLUMN ${mig.column} ${mig.type}`);
      }
    }
  }
}
runMigrations();

// ─── Prepared Statements ────────────────────────────────────────────────────
const stmts = {
  // Rooms
  createRoom: db.prepare(`INSERT INTO rooms (id, name, description, turn_mode, turn_order) VALUES (?, ?, ?, ?, ?)`),
  getRoom: db.prepare(`SELECT * FROM rooms WHERE id = ?`),
  listRooms: db.prepare(`SELECT r.*, COUNT(m.id) as message_count FROM rooms r LEFT JOIN messages m ON m.room_id = r.id GROUP BY r.id ORDER BY r.updated_at DESC`),
  updateRoomTurn: db.prepare(`UPDATE rooms SET current_turn = ?, updated_at = datetime('now') WHERE id = ?`),
  updateRoom: db.prepare(`UPDATE rooms SET name = COALESCE(?, name), description = COALESCE(?, description), turn_mode = COALESCE(?, turn_mode), turn_order = COALESCE(?, turn_order), updated_at = datetime('now') WHERE id = ?`),
  deleteRoom: db.prepare(`DELETE FROM rooms WHERE id = ?`),

  // Agents
  createAgent: db.prepare(`INSERT INTO agents (id, name, avatar_emoji, color, avatar_url) VALUES (?, ?, ?, ?, ?)`),
  getAgent: db.prepare(`SELECT * FROM agents WHERE id = ?`),
  listAgents: db.prepare(`SELECT * FROM agents ORDER BY name`),
  updateAgent: db.prepare(`UPDATE agents SET name = COALESCE(?, name), avatar_emoji = COALESCE(?, avatar_emoji), color = COALESCE(?, color), avatar_url = COALESCE(?, avatar_url) WHERE id = ?`),
  updateAgentAvatar: db.prepare(`UPDATE agents SET avatar_url = ? WHERE id = ?`),

  // Messages
  insertMessage: db.prepare(`INSERT INTO messages (id, room_id, agent_id, content, sequence, msg_type, metadata) VALUES (?, ?, ?, ?, ?, ?, ?)`),
  getMessages: db.prepare(`SELECT m.*, a.name as agent_name, a.avatar_emoji, a.avatar_url, a.color FROM messages m LEFT JOIN agents a ON m.agent_id = a.id WHERE m.room_id = ? ORDER BY m.sequence DESC`),
  getMessagesPaginated: db.prepare(`SELECT m.*, a.name as agent_name, a.avatar_emoji, a.avatar_url, a.color FROM messages m LEFT JOIN agents a ON m.agent_id = a.id WHERE m.room_id = ? ORDER BY m.sequence DESC LIMIT ? OFFSET ?`),
  getMessagesAfterSeq: db.prepare(`SELECT m.*, a.name as agent_name, a.avatar_emoji, a.avatar_url, a.color FROM messages m LEFT JOIN agents a ON m.agent_id = a.id WHERE m.room_id = ? AND m.sequence > ? ORDER BY m.sequence DESC`),
  getMaxSequence: db.prepare(`SELECT COALESCE(MAX(sequence), 0) as max_seq FROM messages WHERE room_id = ?`),
  searchMessages: db.prepare(`SELECT m.*, a.name as agent_name, a.avatar_emoji, a.color FROM messages m LEFT JOIN agents a ON m.agent_id = a.id WHERE m.room_id = ? AND m.content LIKE ? ORDER BY m.sequence DESC LIMIT 50`),
  searchAllMessages: db.prepare(`SELECT m.*, a.name as agent_name, a.avatar_emoji, a.color, r.name as room_name FROM messages m LEFT JOIN agents a ON m.agent_id = a.id LEFT JOIN rooms r ON m.room_id = r.id WHERE m.content LIKE ? ORDER BY m.created_at DESC LIMIT 50`),
  deleteRoomMessages: db.prepare(`DELETE FROM messages WHERE room_id = ?`),
  deleteMessage: db.prepare(`DELETE FROM messages WHERE id = ?`),
  getMessageById: db.prepare(`SELECT * FROM messages WHERE id = ?`),

  // Discussion Management
  getAgentRoom: db.prepare(`SELECT * FROM agents_rooms WHERE agent_id = ? AND room_id = ?`),
  setAgentNoComments: db.prepare(`INSERT OR REPLACE INTO agents_rooms (agent_id, room_id, no_comments) VALUES (?, ?, ?)`),
  getAllAgentsInRoom: db.prepare(`SELECT ar.agent_id, ar.room_id, ar.no_comments FROM agents_rooms ar INNER JOIN agents a ON ar.agent_id = a.id WHERE ar.room_id = ?`),
  resetAllAgentsInRoom: db.prepare(`UPDATE agents_rooms SET no_comments = 0 WHERE room_id = ?`),
  getRoomDiscussion: db.prepare(`SELECT * FROM rooms WHERE id = ?`),
  setRoomDiscussion: db.prepare(`UPDATE rooms SET discussion = ?, moderator_id = ?, discussion_timeout = ?, last_activity_at = ? WHERE id = ?`),
  stopRoomDiscussion: db.prepare(`UPDATE rooms SET discussion = 0, moderator_id = NULL WHERE id = ?`),
  updateRoomActivity: db.prepare(`UPDATE rooms SET last_activity_at = datetime('now') WHERE id = ?`),

  // Room agents
  addAgentToRoom: db.prepare(`INSERT OR IGNORE INTO room_agents (room_id, agent_id) VALUES (?, ?)`),
  getRoomAgents: db.prepare(`SELECT a.* FROM agents a INNER JOIN room_agents ra ON a.id = ra.agent_id WHERE ra.room_id = ?`),
  removeAgentFromRoom: db.prepare(`DELETE FROM room_agents WHERE room_id = ? AND agent_id = ?`),

  // Settings
  getSetting: db.prepare(`SELECT value FROM settings WHERE key = ?`),
  setSetting: db.prepare(`INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))`),
  getAllSettings: db.prepare(`SELECT * FROM settings`),
};

// ─── Turn-Taking Logic ──────────────────────────────────────────────────────
function validateTurn(room, agentId) {
  if (room.turn_mode === 'free') return { ok: true };

  if (room.turn_mode === 'strict') {
    if (room.current_turn && room.current_turn !== agentId) {
      return { ok: false, error: `Not your turn. Current turn: ${room.current_turn}` };
    }
    return { ok: true };
  }

  if (room.turn_mode === 'round_robin') {
    const order = JSON.parse(room.turn_order || '[]');
    if (order.length === 0) return { ok: true };
    if (room.current_turn && room.current_turn !== agentId) {
      return { ok: false, error: `Not your turn. Current turn: ${room.current_turn}` };
    }
    return { ok: true };
  }

  return { ok: true };
}

function advanceTurn(room, currentAgentId) {
  if (room.turn_mode === 'free') return;

  const order = JSON.parse(room.turn_order || '[]');
  if (order.length < 2) return;

  const currentIdx = order.indexOf(currentAgentId);
  const nextIdx = (currentIdx + 1) % order.length;
  const nextAgent = order[nextIdx];

  stmts.updateRoomTurn.run(nextAgent, room.id);
}

// ─── Express App ────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// CORS for local dev
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, X-Agent-Id');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH');
  next();
});

// ─── Multer Config for Avatar Upload ────────────────────────────────────────
const avatarsDir = path.join(__dirname, 'public', 'avatars');
if (!fs.existsSync(avatarsDir)) {
  fs.mkdirSync(avatarsDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, avatarsDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${req.params.id}${ext}`);
  }
});
const upload = multer({ storage, limits: { fileSize: 2 * 1024 * 1024 } });

// ─── API Routes: Agents ─────────────────────────────────────────────────────
app.post('/api/agents', (req, res) => {
  const { name, avatar_emoji, color, avatar_url } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });
  const id = req.body.id || uuidv4();
  try {
    stmts.createAgent.run(id, name, avatar_emoji || '🤖', color || '#6366f1', avatar_url || '');
    const agent = stmts.getAgent.get(id);
    broadcast({ type: 'agent_created', agent });
    res.status(201).json(agent);
  } catch (e) {
    if (e.message.includes('UNIQUE')) {
      return res.status(409).json({ error: 'Agent ID already exists' });
    }
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/agents', (req, res) => {
  res.json(stmts.listAgents.all());
});

app.get('/api/agents/:id', (req, res) => {
  const agent = stmts.getAgent.get(req.params.id);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });
  res.json(agent);
});

app.patch('/api/agents/:id', (req, res) => {
  const { name, avatar_emoji, color, avatar_url } = req.body;
  stmts.updateAgent.run(name || null, avatar_emoji || null, color || null, avatar_url || null, req.params.id);
  const agent = stmts.getAgent.get(req.params.id);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });
  res.json(agent);
});

// Upload avatar image
app.post('/api/agents/:id/avatar', upload.single('avatar'), (req, res) => {
  const agentId = req.params.id;
  const agent = stmts.getAgent.get(agentId);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });
  
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }
  
  const avatarUrl = `/avatars/${req.file.filename}`;
  stmts.updateAgentAvatar.run(avatarUrl, agentId);
  
  const updatedAgent = stmts.getAgent.get(agentId);
  broadcast({ type: 'agent_updated', agent: updatedAgent });
  res.json(updatedAgent);
});

// ─── API Routes: Rooms ──────────────────────────────────────────────────────
app.post('/api/rooms', (req, res) => {
  const { name, description, turn_mode, agent_ids } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });
  const id = req.body.id || uuidv4();
  const mode = turn_mode || 'round_robin';
  const turnOrder = agent_ids || [];

  const create = db.transaction(() => {
    stmts.createRoom.run(id, name, description || '', mode, JSON.stringify(turnOrder));
    for (const agentId of turnOrder) {
      stmts.addAgentToRoom.run(id, agentId);
    }
    if (turnOrder.length > 0 && mode !== 'free') {
      stmts.updateRoomTurn.run(turnOrder[0], id);
    }
  });

  try {
    create();
    const room = stmts.getRoom.get(id);
    broadcast({ type: 'room_created', room });
    res.status(201).json(room);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/rooms', (req, res) => {
  const rooms = stmts.listRooms.all();
  res.json(rooms);
});

app.get('/api/rooms/:id', (req, res) => {
  const room = stmts.getRoom.get(req.params.id);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  const agents = stmts.getRoomAgents.all(req.params.id);
  // 获取每个 agent 的 no_comments 状态
  const agentsWithStatus = agents.map(a => {
    const agentRoom = stmts.getAgentRoom.get(a.id, req.params.id);
    return {
      ...a,
      no_comments: agentRoom ? agentRoom.no_comments : 0
    };
  });
  res.json({ ...room, agents: agentsWithStatus });
});

app.patch('/api/rooms/:id', (req, res) => {
  const { name, description, turn_mode, turn_order } = req.body;
  stmts.updateRoom.run(
    name || null, description || null, turn_mode || null,
    turn_order ? JSON.stringify(turn_order) : null, req.params.id
  );
  const room = stmts.getRoom.get(req.params.id);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  broadcast({ type: 'room_updated', room });
  res.json(room);
});

app.delete('/api/rooms/:id', (req, res) => {
  stmts.deleteRoomMessages.run(req.params.id);
  stmts.deleteRoom.run(req.params.id);
  broadcast({ type: 'room_deleted', room_id: req.params.id });
  res.json({ ok: true });
});

// ─── API Routes: Messages ───────────────────────────────────────────────────
app.post('/api/rooms/:roomId/messages', (req, res) => {
  const { roomId } = req.params;
  const { agent_id, content, msg_type, metadata } = req.body;

  if (!content) return res.status(400).json({ error: 'content is required' });

  const room = stmts.getRoom.get(roomId);
  if (!room) return res.status(404).json({ error: 'Room not found' });

  // Rate limit for free mode
  if (room.turn_mode === 'free' && agent_id) {
    const rateCheck = checkRateLimit(roomId, agent_id);
    if (!rateCheck.allowed) {
      return res.status(429).json({
        error: `Rate limit: Please wait ${Math.ceil(rateCheck.remaining_ms / 1000)} seconds before sending another message`,
        remaining_ms: rateCheck.remaining_ms
      });
    }
  }

  // Validate agent api_key
  if (agent_id) {
    const { api_key } = req.body;
    const agent = stmts.getAgent.get(agent_id);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
    if (agent.api_key && agent.api_key !== api_key) {
      return res.status(403).json({ error: 'Invalid api_key' });
    }
  }

  // Validate agent exists if provided
  if (agent_id) {
    const agent = stmts.getAgent.get(agent_id);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
  }

  // Turn validation
  if (agent_id) {
    const turnCheck = validateTurn(room, agent_id);
    if (!turnCheck.ok) {
      return res.status(403).json({
        error: turnCheck.error,
        current_turn: room.current_turn,
        hint: 'Wait for your turn or change room turn_mode to "free"'
      });
    }
  }

  const sendMessage = db.transaction(() => {
    const { max_seq } = stmts.getMaxSequence.get(roomId);
    const seq = max_seq + 1;
    const id = uuidv4();

    stmts.insertMessage.run(
      id, roomId, agent_id || null, content, seq,
      msg_type || 'message', JSON.stringify(metadata || {})
    );

    // Advance turn
    if (agent_id) advanceTurn(room, agent_id);

    // Get the full message with agent info
    const messages = stmts.getMessagesAfterSeq.all(roomId, seq - 1);
    return messages[0];
  });

  try {
    const message = sendMessage();
    // Get updated room for turn info
    const updatedRoom = stmts.getRoom.get(roomId);
    broadcast({
      type: 'new_message',
      room_id: roomId,
      message,
      current_turn: updatedRoom.current_turn
    });
    res.status(201).json({
      ...message,
      current_turn: updatedRoom.current_turn
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/rooms/:roomId/messages', (req, res) => {
  const { roomId } = req.params;
  const { limit, offset, after_sequence } = req.query;

  const room = stmts.getRoom.get(roomId);
  if (!room) return res.status(404).json({ error: 'Room not found' });

  // Default limit to 100 to prevent loading too many messages
  const DEFAULT_LIMIT = 100;
  const MAX_LIMIT = 500;
  let effectiveLimit = Math.min(limit ? parseInt(limit) : DEFAULT_LIMIT, MAX_LIMIT);

  let messages;
  if (after_sequence) {
    messages = stmts.getMessagesAfterSeq.all(roomId, parseInt(after_sequence));
  } else {
    // Use pagination with default limit
    messages = stmts.getMessagesPaginated.all(roomId, effectiveLimit, parseInt(offset || 0));
  }

  res.json({
    messages,
    room: {
      id: room.id,
      name: room.name,
      current_turn: room.current_turn,
      turn_mode: room.turn_mode
    }
  });
});

// ─── API Routes: Search ─────────────────────────────────────────────────────
app.get('/api/search', (req, res) => {
  const { q, room_id } = req.query;
  if (!q) return res.status(400).json({ error: 'q (query) is required' });
  const pattern = `%${q}%`;

  let messages;
  if (room_id) {
    messages = stmts.searchMessages.all(room_id, pattern);
  } else {
    messages = stmts.searchAllMessages.all(pattern);
  }
  res.json({ query: q, results: messages });
});

// Default limits for context API
const DEFAULT_LAST_N = 10;
const MIN_LAST_N = 1;
const MAX_LAST_N = 100;

// ─── API Routes: Context (for agents to get conversation context) ───────────
app.get('/api/rooms/:roomId/context', (req, res) => {
  const { roomId } = req.params;
  const { last_n, agent_id } = req.query;

  const room = stmts.getRoom.get(roomId);
  if (!room) return res.status(404).json({ error: 'Room not found' });

  // Get settings from database
  const settings = stmts.getAllSettings.all();
  const settingsMap = {};
  for (const s of settings) settingsMap[s.key] = parseInt(s.value) || DEFAULT_LAST_N;
  
  const minLimit = settingsMap.context_min_limit || MIN_LAST_N;
  const maxLimit = settingsMap.context_max_limit || MAX_LAST_N;
  const defaultLimit = settingsMap.context_default_limit || DEFAULT_LAST_N;

  const allMessages = stmts.getMessages.all(roomId);
  
  // Default to defaultLimit if not specified, otherwise use the value (clamped)
  let effectiveLimit = defaultLimit;
  if (last_n) {
    effectiveLimit = Math.min(Math.max(parseInt(last_n), minLimit), maxLimit);
  }
  
  const messages = allMessages.slice(-effectiveLimit);

  // Get agents list
  const agents = stmts.getRoomAgents.all(roomId);
  
  // Build context info
  const currentAgent = agent_id ? agents.find(a => a.id === agent_id) : null;
  const otherAgents = agents.filter(a => a.id !== agent_id);
  
  // Format as a conversation transcript for agent consumption
  const transcript = messages.map(m => ({
    role: m.agent_name || 'system',
    content: m.content,
    sequence: m.sequence,
    timestamp: m.created_at
  }));

  // Build system prompt
  let systemPrompt = '';
  if (currentAgent) {
    const otherNames = otherAgents.map(a => a.name).join(', ') || 'another agent';
    systemPrompt = `你 [${currentAgent.name}] 正在和 ${otherNames} 讨论问题。\n请根据以下对话历史，回复对方的消息。\n\n对话历史：`;
  }

  res.json({
    room: { id: room.id, name: room.name, current_turn: room.current_turn, turn_mode: room.turn_mode },
    agents: agents,
    total_messages: allMessages.length,
    effective_limit: effectiveLimit,
    current_agent: currentAgent,
    system_prompt: systemPrompt,
    transcript
  });
});

// ─── API: Room turn management ──────────────────────────────────────────────
app.post('/api/rooms/:roomId/set-turn', (req, res) => {
  const { agent_id } = req.body;
  const room = stmts.getRoom.get(req.params.roomId);
  if (!room) return res.status(404).json({ error: 'Room not found' });

  stmts.updateRoomTurn.run(agent_id, req.params.roomId);
  broadcast({ type: 'turn_changed', room_id: req.params.roomId, current_turn: agent_id });
  res.json({ ok: true, current_turn: agent_id });
});

// ─── API: Clear room messages ───────────────────────────────────────────────
app.delete('/api/rooms/:roomId/messages', (req, res) => {
  stmts.deleteRoomMessages.run(req.params.roomId);
  const order = JSON.parse(stmts.getRoom.get(req.params.roomId)?.turn_order || '[]');
  if (order.length > 0) stmts.updateRoomTurn.run(order[0], req.params.roomId);
  broadcast({ type: 'messages_cleared', room_id: req.params.roomId });
  res.json({ ok: true });
});

// ─── API: Delete single message ───────────────────────────────────────────────
app.delete('/api/messages/:messageId', (req, res) => {
  const { messageId } = req.params;
  const message = stmts.getMessageById.get(messageId);
  if (!message) return res.status(404).json({ error: 'Message not found' });
  
  stmts.deleteMessage.run(messageId);
  broadcast({ type: 'message_deleted', message_id: messageId, room_id: message.room_id });
  res.json({ ok: true });
});

// ─── API: Batch delete messages ───────────────────────────────────────────────
app.delete('/api/messages', (req, res) => {
  const { ids, room_id } = req.body;
  if (!ids || !Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: 'ids array is required' });
  }
  
  const placeholders = ids.map(() => '?').join(',');
  db.exec(`DELETE FROM messages WHERE id IN (${placeholders})`, ids);
  
  broadcast({ type: 'messages_deleted', message_ids: ids, room_id });
  res.json({ ok: true, deleted_count: ids.length });
});

// ─── Agent Webhooks (notify agents when it's their turn) ────────────────────
const agentWebhooks = new Map(); // agent_id -> callback URL

app.post('/api/agents/:id/webhook', (req, res) => {
  const { callback_url } = req.body;
  if (!callback_url) return res.status(400).json({ error: 'callback_url is required' });
  const agent = stmts.getAgent.get(req.params.id);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });
  agentWebhooks.set(req.params.id, callback_url);
  res.json({ ok: true, agent_id: req.params.id, callback_url });
});

app.delete('/api/agents/:id/webhook', (req, res) => {
  agentWebhooks.delete(req.params.id);
  res.json({ ok: true });
});

app.get('/api/webhooks', (req, res) => {
  const hooks = {};
  for (const [id, url] of agentWebhooks) hooks[id] = url;
  res.json(hooks);
});

// Agent 在线状态 API（读取 webhook-trigger 维护的状态文件）
app.get('/api/agent-status', (req, res) => {
  const statusFile = '/tmp/discussion-status.json';
  try {
    if (fs.existsSync(statusFile)) {
      const status = JSON.parse(fs.readFileSync(statusFile, 'utf8'));
      res.json(status);
    } else {
      res.json({ alalei: false, ximige: false });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});



// ─── API Routes: Discussion ──────────────────────────────────────────────────

app.get('/api/rooms/:roomId/discussion-status', (req, res) => {
  const { roomId } = req.params;
  const room = stmts.getRoomDiscussion.get(roomId);
  if (!room) return res.status(404).json({ error: 'Room not found' });

  const agentsInRoom = stmts.getAllAgentsInRoom.all(roomId);
  const noCommentsMap = {};
  let agreedCount = 0;

  for (const agent of agentsInRoom) {
    const agentRoom = stmts.getAgentRoom.get(agent.agent_id, roomId);
    const noComments = agentRoom ? agentRoom.no_comments : 0;
    noCommentsMap[agent.agent_id] = noComments;
    if (noComments === 1) agreedCount++;
  }

  const totalAgents = agentsInRoom.length;
  const shouldContinue = agreedCount < totalAgents;

  let timeoutRemaining = null;
  if (room.discussion === 1) {
    const lastActivity = new Date(room.last_activity_at);
    const now = new Date();
    const elapsed = (now - lastActivity) / 1000;
    const timeout = room.discussion_timeout || 300;
    timeoutRemaining = Math.max(0, timeout - elapsed);
  }

  res.json({
    discussion: room.discussion === 1,
    moderator_id: room.moderator_id,
    no_comments: noCommentsMap,
    shouldContinue,
    lastActivity: room.last_activity_at,
    timeoutRemaining
  });
});

app.post('/api/rooms/:roomId/agents/:agentId/no-comments', (req, res) => {
  const { roomId, agentId } = req.params;
  const { no_comments } = req.body;

  const agent = stmts.getAgent.get(agentId);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });

  stmts.setAgentNoComments.run(agentId, roomId, no_comments ? 1 : 0);
  stmts.updateRoomActivity.run(roomId);

  res.json({ success: true, message: 'Agent no_comments status updated' });
});

app.post('/api/rooms/:roomId/discussion/start', (req, res) => {
  const { roomId } = req.params;
  const { moderator_id, timeout_seconds } = req.body;

  const room = stmts.getRoom.get(roomId);
  if (!room) return res.status(404).json({ error: 'Room not found' });

  const agent = stmts.getAgent.get(moderator_id);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });

  stmts.resetAllAgentsInRoom.run(roomId);
  stmts.setRoomDiscussion.run(1, moderator_id, timeout_seconds || 300, new Date().toISOString(), roomId);

  broadcast({
    type: 'discussion_started',
    room_id: roomId,
    moderator_id: moderator_id
  });

  res.json({
    success: true,
    message: 'Discussion started',
    roomStatus: {
      discussion: true,
      moderator_id: moderator_id,
      timeout: timeout_seconds || 300
    }
  });
});

app.post('/api/rooms/:roomId/discussion/stop', (req, res) => {
  const { roomId } = req.params;
  const { reason, send_alert } = req.body;

  const room = stmts.getRoom.get(roomId);
  if (!room) return res.status(404).json({ error: 'Room not found' });

  stmts.stopRoomDiscussion.run(roomId);

  const result = {
    success: true,
    message: 'Discussion stopped: ' + reason,
    reason: reason
  };

  if (send_alert) {
    result.alert_sent = true;
  }

  broadcast({
    type: 'discussion_stopped',
    room_id: roomId,
    reason: reason
  });

  res.json(result);
});

app.get('/api/rooms/:roomId/timeout-check', (req, res) => {
  const { roomId } = req.params;
  const room = stmts.getRoomDiscussion.get(roomId);
  if (!room) return res.status(404).json({ error: 'Room not found' });

  if (room.discussion !== 1) {
    return res.json({
      shouldReset: false,
      reason: 'not in discussion',
      elapsed: 0
    });
  }

  const timeout = room.discussion_timeout || 300;
  const lastActivity = new Date(room.last_activity_at);
  const now = new Date();
  const elapsed = (now - lastActivity) / 1000;

  if (elapsed > timeout) {
    stmts.resetAllAgentsInRoom.run(roomId);
    stmts.stopRoomDiscussion.run(roomId);

    res.json({
      shouldReset: true,
      reason: 'timeout after ' + elapsed + 's (timeout: ' + timeout + 's)',
      elapsed: elapsed,
      resetDetails: {
        agentsReset: true,
        discussionStopped: true
      }
    });
  }

  res.json({
    shouldReset: false,
    reason: 'active',
    elapsed: elapsed
  });
});

// ─── API: Settings ───────────────────────────────────────────────────────────
app.get('/api/settings', (req, res) => {
  const settings = stmts.getAllSettings.all();
  const result = {};
  for (const s of settings) {
    result[s.key] = s.value;
  }
  // Provide defaults if not set
  result.context_default_limit = result.context_default_limit || String(DEFAULT_LAST_N);
  result.context_max_limit = result.context_max_limit || String(MAX_LAST_N);
  result.context_min_limit = result.context_min_limit || String(MIN_LAST_N);
  res.json(result);
});

app.post('/api/settings', (req, res) => {
  const { key, value } = req.body;
  if (!key) return res.status(400).json({ error: 'key is required' });
  
  // Validate key
  const allowedKeys = ['context_default_limit', 'context_max_limit', 'context_min_limit'];
  if (!allowedKeys.includes(key)) {
    return res.status(400).json({ error: `Invalid key. Allowed: ${allowedKeys.join(', ')}` });
  }
  
  // Validate value
  const numValue = parseInt(value);
  if (isNaN(numValue)) {
    return res.status(400).json({ error: 'value must be a number' });
  }
  
  stmts.setSetting.run(key, String(numValue));
  res.json({ ok: true, key, value: numValue });
});

async function notifyAgent(agentId, payload) {
  const url = agentWebhooks.get(agentId);
  if (!url) return;
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5000)
    });
  } catch (e) {
    console.log(`[webhook] Failed to notify ${agentId} at ${url}: ${e.message}`);
  }
}

// ─── Long Polling (agent waits for their turn) ─────────────────────────────
const waitingClients = new Map(); // agent_id -> [{ res, timer }]

app.get('/api/rooms/:roomId/wait-turn/:agentId', (req, res) => {
  const { roomId, agentId } = req.params;
  const timeout = parseInt(req.query.timeout) || 30;

  const room = stmts.getRoom.get(roomId);
  if (!room) return res.status(404).json({ error: 'Room not found' });

  // If it's already this agent's turn, respond immediately
  if (room.current_turn === agentId || room.turn_mode === 'free') {
    const context = stmts.getMessages.all(roomId);
    return res.json({
      your_turn: true,
      room_id: roomId,
      current_turn: room.current_turn,
      last_message: context.length > 0 ? context[context.length - 1] : null,
      total_messages: context.length
    });
  }

  // Otherwise, hold the connection open until it's their turn
  const timer = setTimeout(() => {
    removeWaiter(agentId, res);
    res.json({ your_turn: false, room_id: roomId, current_turn: room.current_turn, timeout: true });
  }, timeout * 1000);

  const key = `${roomId}:${agentId}`;
  if (!waitingClients.has(key)) waitingClients.set(key, []);
  waitingClients.get(key).push({ res, timer });

  req.on('close', () => removeWaiter(agentId, res));
});

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

// ─── WebSocket ──────────────────────────────────────────────────────────────
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

const clients = new Set();

function broadcast(data) {
  const msg = JSON.stringify(data);
  for (const ws of clients) {
    if (ws.readyState === 1) ws.send(msg);
  }

  // Also notify via webhook + long-poll if a turn changed
  if (data.current_turn) {
    notifyAgent(data.current_turn, data);
    notifyWaiters(data.room_id, data.current_turn);
  }
}

wss.on('connection', (ws) => {
  clients.add(ws);
  ws.on('close', () => clients.delete(ws));
  ws.on('error', () => clients.delete(ws));

  // Send initial state
  ws.send(JSON.stringify({
    type: 'connected',
    rooms: stmts.listRooms.all(),
    agents: stmts.listAgents.all()
  }));
});

// ─── Serve Frontend ─────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── Start ──────────────────────────────────────────────────────────────────
const os = require('os');

function getLanIP() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return 'unknown';
}

server.listen(PORT, '0.0.0.0', () => {
  const lanIP = getLanIP();
  console.log(`
┌──────────────────────────────────────────────────┐
│  Agent Chat Platform                             │
│  ──────────────────────────────────────────────  │
│                                                  │
│  Local:     http://localhost:${PORT}                │
│  LAN:       http://${lanIP}:${PORT}    │
│                                                  │
│  API:       http://${lanIP}:${PORT}/api │
│  WebSocket: ws://${lanIP}:${PORT}/ws    │
│  Database:  ${DB_PATH}                            │
│                                                  │
│  ➜ Open the LAN URL from any device on           │
│    the same Wi-Fi network                        │
└──────────────────────────────────────────────────┘
  `);
});
