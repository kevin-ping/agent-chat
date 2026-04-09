'use strict';
const fs = require('fs');
const path = require('path');

const MIGRATION_DIR = path.join(__dirname, '..', '..', 'data');
const V2_FLAG = path.join(MIGRATION_DIR, '.migration-v2-complete');

function runMigrations(db) {
  // ── Migration v2: Restructure for CLI-driven architecture ──────────────
  // Removes: settings, pending_registrations tables
  // Removes from agents: api_key, webhook_token, agent_hook_url, session_key
  // Adds to agents: channel_name
  // Removes from rooms: discussion_timeout (no longer used)
  if (!fs.existsSync(V2_FLAG)) {
    console.log('[Migration v2] Starting CLI-architecture migration...');
    db.pragma('foreign_keys = OFF');

    try {
      // ── Step 1: Rebuild agents table (drop removed columns, add channel_name)
      const agentCols = db.prepare('PRAGMA table_info(agents)').all().map(c => c.name);

      if (agentCols.includes('api_key') || agentCols.includes('agent_hook_url')) {
        console.log('[Migration v2] Rebuilding agents table...');
        db.exec(`DROP TABLE IF EXISTS agents_v2;`);
        db.exec(`
          CREATE TABLE agents_v2 (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            agent_id     TEXT    UNIQUE NOT NULL,
            name         TEXT    NOT NULL,
            color        TEXT    DEFAULT '#6366f1',
            avatar_url   TEXT    DEFAULT '',
            channel_type TEXT    DEFAULT NULL,
            channel_id   TEXT    DEFAULT NULL,
            channel_name TEXT    DEFAULT NULL,
            created_at   DATETIME DEFAULT (datetime('now'))
          );
        `);

        db.exec(`
          INSERT INTO agents_v2 (id, agent_id, name, color, avatar_url, channel_type, channel_id, created_at)
            SELECT id, agent_id, name, color, avatar_url, channel_type, channel_id, created_at
            FROM agents;
        `);

        db.exec(`DROP TABLE agents; ALTER TABLE agents_v2 RENAME TO agents;`);
        console.log('[Migration v2] agents table rebuilt (removed api_key, webhook_token, agent_hook_url, session_key; added channel_name).');
      } else if (!agentCols.includes('channel_name')) {
        // agents already clean but missing channel_name
        db.exec(`ALTER TABLE agents ADD COLUMN channel_name TEXT DEFAULT NULL`);
        console.log('[Migration v2] Added channel_name column to agents.');
      }

      // ── Step 2: Remove discussion_timeout from rooms
      const roomCols = db.prepare('PRAGMA table_info(rooms)').all().map(c => c.name);
      if (roomCols.includes('discussion_timeout')) {
        console.log('[Migration v2] Rebuilding rooms table (removing discussion_timeout)...');
        db.exec(`DROP TABLE IF EXISTS rooms_v2;`);
        db.exec(`
          CREATE TABLE rooms_v2 (
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
            last_activity_at DATETIME DEFAULT NULL,
            in_confirmation INT DEFAULT 0,
            owner       TEXT    DEFAULT NULL,
            room_password TEXT  DEFAULT '',
            topic_id    INTEGER DEFAULT NULL
          );
        `);

        db.exec(`
          INSERT INTO rooms_v2 (id, name, description, turn_mode, current_turn, turn_order,
                                 created_at, updated_at, discussion, moderator_id,
                                 last_activity_at, in_confirmation, owner, room_password, topic_id)
            SELECT id, name, description, turn_mode, current_turn, turn_order,
                   created_at, updated_at, discussion, moderator_id,
                   last_activity_at, in_confirmation, owner, room_password,
                   ${roomCols.includes('topic_id') ? 'topic_id' : 'NULL'}
            FROM rooms;
        `);

        db.exec(`DROP TABLE rooms; ALTER TABLE rooms_v2 RENAME TO rooms;`);
        console.log('[Migration v2] rooms table rebuilt (removed discussion_timeout).');
      }

      // ── Step 3: Drop settings and pending_registrations tables
      const tables = db.prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name IN ('settings', 'pending_registrations')`
      ).all().map(t => t.name);

      for (const table of tables) {
        db.exec(`DROP TABLE IF EXISTS ${table};`);
        console.log(`[Migration v2] Dropped ${table} table.`);
      }

      // ── Step 4: Drop legacy tables if they still exist
      db.exec(`DROP TABLE IF EXISTS room_agents;`);

    } finally {
      db.pragma('foreign_keys = ON');
    }

    // Write file-based migration flag
    try { fs.mkdirSync(MIGRATION_DIR, { recursive: true }); } catch (_) {}
    fs.writeFileSync(V2_FLAG, `Migration v2 completed at ${new Date().toISOString()}\n`);
    console.log('[Migration v2] CLI-architecture migration complete.');
  }
}

module.exports = { runMigrations };
