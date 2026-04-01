'use strict';
const Database = require('better-sqlite3');
const { DB_PATH } = require('../src/config');
const db = new Database(DB_PATH, { readonly: true });

const queries = {
  // Returns rooms with integer id
  listRooms: db.prepare(`SELECT id FROM rooms`),

  // Query by integer id (used internally in trigger)
  getRoom: db.prepare(`SELECT * FROM rooms WHERE id = ?`),

  // Query agent by integer id
  getAgent: db.prepare(`
    SELECT id, agent_id, agent_hook_url, webhook_token, session_key
    FROM agents WHERE id = ?
  `),

  // Get all agents in a room by integer room_id
  getRoomAgents: db.prepare(`
    SELECT a.id, a.agent_id, a.name, a.avatar_url,
           a.agent_hook_url, a.webhook_token, a.session_key, a.api_key,
           a.channel_type, a.channel_id
    FROM agents a
    INNER JOIN agents_rooms ar ON a.id = ar.agent_id
    WHERE ar.room_id = ?
  `),

  // Get no_comments status; returns integer agent_id field
  getAgentsNoComments: db.prepare(`
    SELECT agent_id, no_comments FROM agents_rooms WHERE room_id = ?
  `),

  // Get recent messages by integer room_id
  getRecentMessages: db.prepare(`
    SELECT m.agent_id, a.name as agent_name, m.content, m.sequence
    FROM messages m
    LEFT JOIN agents a ON m.agent_id = a.id
    WHERE m.room_id = ?
    ORDER BY m.sequence DESC
    LIMIT ?
  `),

  getRecentMessagesMeta: db.prepare(`
    SELECT agent_id, created_at, sequence
    FROM messages
    WHERE room_id = ?
    ORDER BY sequence DESC
    LIMIT 5
  `),

  getMaxSeq: db.prepare(`
    SELECT COALESCE(MAX(sequence), 0) as max_seq FROM messages WHERE room_id = ?
  `)
};

module.exports = queries;
