'use strict';

function initSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS rooms (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT    NOT NULL,
      description TEXT    DEFAULT '',
      turn_mode   TEXT    DEFAULT 'free',
      current_turn INTEGER DEFAULT NULL,
      turn_order  TEXT    DEFAULT '[]',
      created_at  DATETIME DEFAULT (datetime('now')),
      updated_at  DATETIME DEFAULT (datetime('now')),
      discussion  INT     DEFAULT 0,
      moderator_id INTEGER DEFAULT NULL,
      discussion_timeout INT DEFAULT 300,
      last_activity_at DATETIME DEFAULT NULL,
      in_confirmation INT DEFAULT 0,
      owner       TEXT    DEFAULT NULL,
      room_password TEXT  DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS agents (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id     TEXT    UNIQUE NOT NULL,
      name         TEXT    NOT NULL,
      color        TEXT    DEFAULT '#6366f1',
      avatar_url   TEXT    DEFAULT '',
      agent_hook_url TEXT  DEFAULT '',
      api_key      TEXT    DEFAULT '',
      webhook_token TEXT   DEFAULT '',
      session_key  TEXT    DEFAULT '',
      channel_type TEXT    DEFAULT NULL,
      channel_id   TEXT    DEFAULT NULL,
      created_at   DATETIME DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS messages (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      room_id     INTEGER NOT NULL,
      agent_id    INTEGER,
      content     TEXT    NOT NULL,
      sequence    INTEGER NOT NULL,
      msg_type    TEXT    DEFAULT 'message',
      metadata    TEXT    DEFAULT '{}',
      created_at  DATETIME DEFAULT (datetime('now')),
      topic_id    INTEGER DEFAULT NULL,
      FOREIGN KEY (room_id) REFERENCES rooms(id),
      FOREIGN KEY (agent_id) REFERENCES agents(id),
      FOREIGN KEY (topic_id) REFERENCES topics(id)
    );

    CREATE INDEX IF NOT EXISTS idx_messages_room_seq ON messages(room_id, sequence);
    CREATE INDEX IF NOT EXISTS idx_messages_room_time ON messages(room_id, created_at);

    CREATE TABLE IF NOT EXISTS agents_rooms (
      agent_id INTEGER NOT NULL,
      room_id  INTEGER NOT NULL,
      no_comments INT DEFAULT 0,
      PRIMARY KEY (agent_id, room_id),
      FOREIGN KEY (agent_id) REFERENCES agents(id),
      FOREIGN KEY (room_id)  REFERENCES rooms(id)
    );

    CREATE INDEX IF NOT EXISTS idx_agents_rooms_room_comments ON agents_rooms(room_id, no_comments);

    CREATE TABLE IF NOT EXISTS topics (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      room_id    INTEGER NOT NULL,
      title      TEXT    NOT NULL,
      status     TEXT    DEFAULT 'open',
      created_at DATETIME DEFAULT (datetime('now')),
      closed_at  DATETIME DEFAULT NULL,
      FOREIGN KEY (room_id) REFERENCES rooms(id)
    );

    CREATE INDEX IF NOT EXISTS idx_topics_room_status ON topics(room_id, status);

    CREATE TABLE IF NOT EXISTS settings (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL,
      updated_at DATETIME DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS pending_registrations (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      invitation_token TEXT UNIQUE NOT NULL,
      agent_id         TEXT NOT NULL,
      name             TEXT NOT NULL,
      color            TEXT DEFAULT '#6366f1',
      avatar_url       TEXT DEFAULT '',
      agent_hook_url   TEXT NOT NULL,
      webhook_token    TEXT NOT NULL,
      session_key      TEXT NOT NULL,
      channel_type     TEXT DEFAULT 'telegram',
      channel_id       TEXT NOT NULL,
      created_at       DATETIME DEFAULT (datetime('now')),
      expires_at       DATETIME NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_pending_reg_token ON pending_registrations(invitation_token);
  `);

  // Set flag to prevent legacy INTEGER id + guid migration from running again
  db.prepare(`
    INSERT OR REPLACE INTO settings (key, value, updated_at)
    VALUES ('guid_columns_removed', '1', datetime('now'))
  `).run();
  console.log('[Migration] Set guid_columns_removed flag (using integer-only schema)');
}

module.exports = { initSchema };
