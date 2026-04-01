'use strict';
const db = require('./index');

const stmts = {
  // ── Rooms ──────────────────────────────────────────────────────────────────
  createRoom: db.prepare(`
    INSERT INTO rooms (name, description, turn_mode, turn_order, owner, room_password)
    VALUES (?, ?, ?, ?, ?, ?)
  `),
  getRoom: db.prepare(`
    SELECT id, name, description, turn_mode, current_turn, turn_order, owner, room_password,
           datetime(created_at, 'localtime') as created_at,
           datetime(updated_at, 'localtime') as updated_at,
           discussion, moderator_id, discussion_timeout,
           datetime(last_activity_at, 'localtime') as last_activity_at,
           in_confirmation
    FROM rooms WHERE id = ?
  `),
  listRooms: db.prepare(`
    SELECT r.id, r.name, r.description, r.turn_mode, r.current_turn, r.turn_order,
           r.owner, r.room_password,
           datetime(r.created_at, 'localtime') as created_at,
           datetime(r.updated_at, 'localtime') as updated_at,
           r.discussion, r.in_confirmation, r.moderator_id, r.discussion_timeout,
           datetime(r.last_activity_at, 'localtime') as last_activity_at,
           COUNT(m.id) as message_count
    FROM rooms r
    LEFT JOIN messages m ON m.room_id = r.id
    GROUP BY r.id
    ORDER BY r.id ASC
  `),
  updateRoomTurn: db.prepare(`
    UPDATE rooms SET current_turn = ?, updated_at = datetime('now') WHERE id = ?
  `),
  updateRoom: db.prepare(`
    UPDATE rooms
    SET name        = COALESCE(?, name),
        description = COALESCE(?, description),
        turn_mode   = COALESCE(?, turn_mode),
        turn_order  = COALESCE(?, turn_order),
        updated_at  = datetime('now')
    WHERE id = ?
  `),
  updateRoomPassword: db.prepare(`
    UPDATE rooms SET room_password = ?, updated_at = datetime('now') WHERE id = ?
  `),
  updateRoomOwner: db.prepare(`
    UPDATE rooms SET owner = ?, updated_at = datetime('now') WHERE id = ?
  `),
  deleteRoom: db.prepare(`DELETE FROM rooms WHERE id = ?`),

  // ── Agents ─────────────────────────────────────────────────────────────────
  createAgent: db.prepare(`
    INSERT INTO agents (agent_id, name, color, avatar_url, agent_hook_url,
                        api_key, webhook_token, session_key, channel_type, channel_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `),
  getAgent: db.prepare(`
    SELECT id, agent_id, name, color, avatar_url, agent_hook_url,
           api_key, webhook_token, session_key, channel_type, channel_id,
           datetime(created_at, 'localtime') as created_at
    FROM agents WHERE id = ?
  `),
  getAgentByOpenClawId: db.prepare(`
    SELECT id, agent_id, name, color, avatar_url, agent_hook_url,
           api_key, webhook_token, session_key, channel_type, channel_id,
           datetime(created_at, 'localtime') as created_at
    FROM agents WHERE agent_id = ?
  `),
  listAgents: db.prepare(`
    SELECT id, agent_id, name, color, avatar_url, agent_hook_url,
           webhook_token, session_key, channel_type, channel_id,
           datetime(created_at, 'localtime') as created_at
    FROM agents ORDER BY name
  `),
  updateAgent: db.prepare(`
    UPDATE agents
    SET name          = COALESCE(?, name),
        color         = COALESCE(?, color),
        avatar_url    = COALESCE(?, avatar_url),
        agent_hook_url = COALESCE(?, agent_hook_url),
        webhook_token = COALESCE(?, webhook_token),
        session_key   = COALESCE(?, session_key),
        channel_type  = COALESCE(?, channel_type),
        channel_id    = COALESCE(?, channel_id)
    WHERE id = ?
  `),
  updateAgentAvatar: db.prepare(`UPDATE agents SET avatar_url = ? WHERE id = ?`),
  getAgentByApiKey: db.prepare(`SELECT id FROM agents WHERE api_key = ?`),

  // ── Topics ─────────────────────────────────────────────────────────────────
  insertTopic: db.prepare(`
    INSERT INTO topics (room_id, title) VALUES (?, ?)
  `),
  getTopic: db.prepare(`
    SELECT id, room_id, title, status,
           datetime(created_at, 'localtime') as created_at,
           datetime(closed_at,  'localtime') as closed_at
    FROM topics WHERE id = ?
  `),
  getOpenTopicForRoom: db.prepare(`
    SELECT id, room_id, title, status,
           datetime(created_at, 'localtime') as created_at
    FROM topics WHERE room_id = ? AND status = 'open'
    ORDER BY created_at DESC LIMIT 1
  `),
  closeTopic: db.prepare(`
    UPDATE topics SET status = 'closed', closed_at = datetime('now') WHERE id = ?
  `),
  listTopics: db.prepare(`
    SELECT t.id, t.room_id, t.title, t.status,
           datetime(t.created_at, 'localtime') as created_at,
           datetime(t.closed_at,  'localtime') as closed_at,
           COUNT(m.id) as message_count
    FROM topics t
    LEFT JOIN messages m ON m.topic_id = t.id
    WHERE t.room_id = ?
    GROUP BY t.id
    ORDER BY t.created_at DESC
  `),
  getTopicMessages: db.prepare(`
    SELECT m.id, m.room_id, m.agent_id, m.content, m.sequence, m.msg_type,
           datetime(m.created_at, 'localtime') as created_at,
           a.name as agent_name, a.color, a.avatar_url
    FROM messages m
    LEFT JOIN agents a ON m.agent_id = a.id
    WHERE m.topic_id = ?
    ORDER BY m.sequence ASC
  `),
  deleteTopicMessages: db.prepare(`DELETE FROM messages WHERE topic_id = ?`),
  deleteTopic: db.prepare(`DELETE FROM topics WHERE id = ?`),

  // ── Messages ───────────────────────────────────────────────────────────────
  insertMessage: db.prepare(`
    INSERT INTO messages (room_id, agent_id, content, sequence, msg_type, metadata, topic_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `),
  getMessages: db.prepare(`
    SELECT m.id, m.room_id, m.agent_id, m.content, m.sequence, m.msg_type, m.metadata,
           datetime(m.created_at, 'localtime') as created_at,
           a.name as agent_name, a.avatar_url, a.color
    FROM messages m
    LEFT JOIN agents a ON m.agent_id = a.id
    WHERE m.room_id = ?
    ORDER BY m.sequence DESC
  `),
  getMessagesPaginated: db.prepare(`
    SELECT m.id, m.room_id, m.agent_id, m.content, m.sequence, m.msg_type, m.metadata,
           datetime(m.created_at, 'localtime') as created_at,
           a.name as agent_name, a.avatar_url, a.color
    FROM messages m
    LEFT JOIN agents a ON m.agent_id = a.id
    WHERE m.room_id = ?
    ORDER BY m.sequence DESC
    LIMIT ? OFFSET ?
  `),
  getMessagesAfterSeq: db.prepare(`
    SELECT m.id, m.room_id, m.agent_id, m.content, m.sequence, m.msg_type, m.metadata,
           datetime(m.created_at, 'localtime') as created_at,
           a.name as agent_name, a.avatar_url, a.color
    FROM messages m
    LEFT JOIN agents a ON m.agent_id = a.id
    WHERE m.room_id = ? AND m.sequence > ?
    ORDER BY m.sequence DESC
  `),
  getMaxSequence: db.prepare(`
    SELECT COALESCE(MAX(sequence), 0) as max_seq FROM messages WHERE room_id = ?
  `),
  searchMessages: db.prepare(`
    SELECT m.id, m.room_id, m.agent_id, m.content, m.sequence, m.msg_type, m.metadata,
           datetime(m.created_at, 'localtime') as created_at,
           a.name as agent_name, a.color
    FROM messages m
    LEFT JOIN agents a ON m.agent_id = a.id
    WHERE m.room_id = ? AND m.content LIKE ?
    ORDER BY m.sequence DESC LIMIT 50
  `),
  searchAllMessages: db.prepare(`
    SELECT m.id, m.room_id, m.agent_id, m.content, m.sequence, m.msg_type, m.metadata,
           datetime(m.created_at, 'localtime') as created_at,
           a.name as agent_name, a.color, r.name as room_name
    FROM messages m
    LEFT JOIN agents a ON m.agent_id = a.id
    LEFT JOIN rooms r ON m.room_id = r.id
    WHERE m.content LIKE ?
    ORDER BY m.created_at DESC LIMIT 50
  `),
  deleteRoomMessages: db.prepare(`DELETE FROM messages WHERE room_id = ?`),
  deleteMessage: db.prepare(`DELETE FROM messages WHERE id = ?`),
  getMessageById: db.prepare(`
    SELECT id, room_id, agent_id, content, sequence, msg_type, metadata,
           datetime(created_at, 'localtime') as created_at
    FROM messages WHERE id = ?
  `),

  // ── Discussion Management ──────────────────────────────────────────────────
  getAgentRoom: db.prepare(`
    SELECT * FROM agents_rooms WHERE agent_id = ? AND room_id = ?
  `),
  setAgentNoComments: db.prepare(`
    INSERT OR REPLACE INTO agents_rooms (agent_id, room_id, no_comments) VALUES (?, ?, ?)
  `),
  getAllAgentsInRoom: db.prepare(`
    SELECT ar.agent_id, ar.room_id, ar.no_comments
    FROM agents_rooms ar
    WHERE ar.room_id = ?
  `),
  resetAllAgentsInRoom: db.prepare(`
    UPDATE agents_rooms SET no_comments = 0 WHERE room_id = ?
  `),
  getRoomDiscussion: db.prepare(`
    SELECT id, name, description, turn_mode, current_turn, turn_order, owner, room_password,
           datetime(created_at, 'localtime') as created_at,
           datetime(updated_at, 'localtime') as updated_at,
           discussion, moderator_id, discussion_timeout,
           datetime(last_activity_at, 'localtime') as last_activity_at,
           in_confirmation
    FROM rooms WHERE id = ?
  `),
  setRoomDiscussion: db.prepare(`
    UPDATE rooms
    SET discussion = ?, moderator_id = ?, discussion_timeout = ?,
        last_activity_at = ?, in_confirmation = 0
    WHERE id = ?
  `),
  stopRoomDiscussion: db.prepare(`
    UPDATE rooms SET discussion = 0, moderator_id = NULL, in_confirmation = 0 WHERE id = ?
  `),
  enterConfirmationRound: db.prepare(`UPDATE rooms SET in_confirmation = 1 WHERE id = ?`),
  exitConfirmationRound: db.prepare(`UPDATE rooms SET in_confirmation = 0 WHERE id = ?`),
  updateRoomActivity: db.prepare(`
    UPDATE rooms SET last_activity_at = datetime('now') WHERE id = ?
  `),

  // ── Room agents ────────────────────────────────────────────────────────────
  addAgentToRoom: db.prepare(`
    INSERT OR IGNORE INTO agents_rooms (room_id, agent_id) VALUES (?, ?)
  `),
  getRoomAgents: db.prepare(`
    SELECT a.id, a.agent_id, a.name, a.color, a.avatar_url, a.agent_hook_url,
           a.webhook_token, a.session_key, a.channel_type, a.channel_id,
           datetime(a.created_at, 'localtime') as created_at
    FROM agents a
    INNER JOIN agents_rooms ar ON a.id = ar.agent_id
    WHERE ar.room_id = ?
  `),
  removeAgentFromRoom: db.prepare(`
    DELETE FROM agents_rooms WHERE room_id = ? AND agent_id = ?
  `),

  // ── Settings ───────────────────────────────────────────────────────────────
  getSetting: db.prepare(`SELECT value FROM settings WHERE key = ?`),
  setSetting: db.prepare(`
    INSERT OR REPLACE INTO settings (key, value, updated_at)
    VALUES (?, ?, datetime('now'))
  `),
  getAllSettings: db.prepare(`
    SELECT key, value, datetime(updated_at, 'localtime') as updated_at FROM settings
  `),

  // ── Pending registrations ──────────────────────────────────────────────────
  createPendingReg: db.prepare(`
    INSERT INTO pending_registrations
      (invitation_token, agent_id, name, color, avatar_url, agent_hook_url,
       webhook_token, session_key, channel_type, channel_id, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `),
  getPendingReg: db.prepare(`
    SELECT * FROM pending_registrations WHERE invitation_token = ?
  `),
  deletePendingReg: db.prepare(`
    DELETE FROM pending_registrations WHERE invitation_token = ?
  `),

  // ── Resource limit counts ──────────────────────────────────────────────────
  countAllRooms: db.prepare(`SELECT COUNT(*) as count FROM rooms`),
  countAllAgents: db.prepare(`SELECT COUNT(*) as count FROM agents`),
  countRoomsByOwner: db.prepare(`SELECT COUNT(*) as count FROM rooms WHERE owner = ?`),
  countAgentsByHookUrl: db.prepare(`SELECT COUNT(*) as count FROM agents WHERE agent_hook_url = ?`),
  countPendingRegsByHookUrl: db.prepare(`
    SELECT COUNT(*) as count FROM pending_registrations WHERE agent_hook_url = ?
  `),
};

module.exports = stmts;
