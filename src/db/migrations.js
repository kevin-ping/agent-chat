'use strict';

function runMigrations(db) {
  // Check if guid removal migration has completed — skip legacy INTEGER id + guid migration
  const guidRemovedFlag = db.prepare(
    `SELECT value FROM settings WHERE key = 'guid_columns_removed'`
  ).get();

  if (guidRemovedFlag && guidRemovedFlag.value === '1') {
    console.log('[Migration] Guid columns already removed — skipping legacy INTEGER id + guid migration');
    // Proceed to Migration 2: turn_order repair
  } else {
    // ── Migration 1: TEXT UUID id → INTEGER AUTOINCREMENT id + guid column ──────
    // Detection: agents table missing 'guid' column means this migration hasn't run.
    const agentCols = db.prepare('PRAGMA table_info(agents)').all().map(c => c.name);

  if (!agentCols.includes('guid')) {
    console.log('[Migration] Starting INTEGER id + guid migration...');
    db.pragma('foreign_keys = OFF');

    try {
      // ── Step 1: Rebuild agents ─────────────────────────────────────────────
      console.log('[Migration] Step 1/4: Rebuilding agents table...');
      db.exec(`DROP TABLE IF EXISTS agents_mig;`);
      db.exec(`
        CREATE TABLE agents_mig (
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          guid         TEXT    UNIQUE NOT NULL,
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
      `);

      // Check if old agents table has agent_id column (post-previous-migration) or just id
      const oldAgentCols = db.prepare('PRAGMA table_info(agents)').all().map(c => c.name);
      if (oldAgentCols.includes('agent_id')) {
        // New-style agents table (has separate agent_id): guid = id (UUID)
        db.exec(`
          INSERT INTO agents_mig (guid, agent_id, name, color, avatar_url, agent_hook_url,
                                   api_key, webhook_token, session_key, channel_type, channel_id, created_at)
            SELECT id, agent_id, name, color, avatar_url,
                   COALESCE(agent_hook_url, ''), COALESCE(api_key, ''),
                   COALESCE(webhook_token, ''), COALESCE(session_key, ''),
                   channel_type, channel_id, created_at
            FROM agents;
        `);
      } else {
        // Old-style agents table (id = human-readable): use random guid
        db.exec(`
          INSERT INTO agents_mig (guid, agent_id, name, color, avatar_url, agent_hook_url,
                                   api_key, webhook_token, session_key, channel_type, channel_id, created_at)
            SELECT lower(hex(randomblob(16))), id, name, color, COALESCE(avatar_url, ''),
                   COALESCE(agent_hook_url, ''), COALESCE(api_key, ''),
                   COALESCE(webhook_token, ''), COALESCE(session_key, ''),
                   channel_type, channel_id, created_at
            FROM agents;
        `);
      }

      db.exec(`DROP TABLE agents; ALTER TABLE agents_mig RENAME TO agents;`);
      console.log('[Migration] agents table rebuilt.');

      // ── Step 2: Rebuild rooms ──────────────────────────────────────────────
      console.log('[Migration] Step 2/4: Rebuilding rooms table...');
      db.exec(`DROP TABLE IF EXISTS rooms_mig;`);
      db.exec(`
        CREATE TABLE rooms_mig (
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          guid         TEXT    UNIQUE NOT NULL,
          name         TEXT    NOT NULL,
          description  TEXT    DEFAULT '',
          turn_mode    TEXT    DEFAULT 'free',
          current_turn INTEGER DEFAULT NULL,
          turn_order   TEXT    DEFAULT '[]',
          created_at   DATETIME DEFAULT (datetime('now')),
          updated_at   DATETIME DEFAULT (datetime('now')),
          discussion   INT     DEFAULT 0,
          moderator_id INTEGER DEFAULT NULL,
          discussion_timeout INT DEFAULT 300,
          last_activity_at DATETIME DEFAULT NULL,
          in_confirmation INT  DEFAULT 0,
          owner        TEXT    DEFAULT NULL,
          room_password TEXT   DEFAULT ''
        );
      `);

      // Copy rooms; convert current_turn UUID → new integer agent id
      db.exec(`
        INSERT INTO rooms_mig (guid, name, description, turn_mode, current_turn, turn_order,
                                created_at, updated_at, discussion, moderator_id,
                                discussion_timeout, last_activity_at, in_confirmation,
                                owner, room_password)
          SELECT
            r.id AS guid,
            r.name,
            COALESCE(r.description, ''),
            COALESCE(r.turn_mode, 'free'),
            -- current_turn: look up new integer id from agents by guid
            (SELECT a.id FROM agents a WHERE a.guid = r.current_turn),
            r.turn_order,
            r.created_at,
            r.updated_at,
            COALESCE(r.discussion, 0),
            -- moderator_id: look up new integer id
            (SELECT a.id FROM agents a WHERE a.guid = r.moderator_id),
            COALESCE(r.discussion_timeout, 300),
            r.last_activity_at,
            COALESCE(r.in_confirmation, 0),
            r.owner,
            COALESCE(r.room_password, '')
          FROM rooms r;
      `);

      // Convert turn_order JSON array (UUIDs → integer ids) using JS
      const rooms = db.prepare('SELECT id, turn_order FROM rooms_mig').all();
      const agentByGuid = db.prepare('SELECT id FROM agents WHERE guid = ?');
      const updateTurnOrder = db.prepare('UPDATE rooms_mig SET turn_order = ? WHERE id = ?');

      for (const room of rooms) {
        try {
          const order = JSON.parse(room.turn_order || '[]');
          const newOrder = order.map(uuid => {
            const found = agentByGuid.get(uuid);
            return found ? found.id : null;
          }).filter(x => x !== null);
          updateTurnOrder.run(JSON.stringify(newOrder), room.id);
        } catch (_) { /* leave as-is on parse error */ }
      }

      db.exec(`DROP TABLE rooms; ALTER TABLE rooms_mig RENAME TO rooms;`);
      console.log('[Migration] rooms table rebuilt.');

      // ── Step 3: Rebuild messages ───────────────────────────────────────────
      console.log('[Migration] Step 3/4: Rebuilding messages table...');
      db.exec(`DROP TABLE IF EXISTS messages_mig;`);
      db.exec(`
        CREATE TABLE messages_mig (
          id       INTEGER PRIMARY KEY AUTOINCREMENT,
          guid     TEXT    UNIQUE NOT NULL,
          room_id  INTEGER NOT NULL,
          agent_id INTEGER,
          content  TEXT    NOT NULL,
          sequence INTEGER NOT NULL,
          msg_type TEXT    DEFAULT 'message',
          metadata TEXT    DEFAULT '{}',
          created_at DATETIME DEFAULT (datetime('now')),
          FOREIGN KEY (room_id)  REFERENCES rooms(id),
          FOREIGN KEY (agent_id) REFERENCES agents(id)
        );
      `);

      db.exec(`
        INSERT INTO messages_mig (guid, room_id, agent_id, content, sequence, msg_type, metadata, created_at)
          SELECT
            lower(hex(randomblob(16))) AS guid,
            (SELECT r.id FROM rooms r WHERE r.guid = m.room_id),
            (SELECT a.id FROM agents a WHERE a.guid = m.agent_id),
            m.content,
            m.sequence,
            COALESCE(m.msg_type, 'message'),
            COALESCE(m.metadata, '{}'),
            m.created_at
          FROM messages m
          WHERE (SELECT r.id FROM rooms r WHERE r.guid = m.room_id) IS NOT NULL;
      `);

      db.exec(`
        DROP TABLE messages;
        ALTER TABLE messages_mig RENAME TO messages;
        CREATE INDEX IF NOT EXISTS idx_messages_room_seq ON messages(room_id, sequence);
        CREATE INDEX IF NOT EXISTS idx_messages_room_time ON messages(room_id, created_at);
      `);
      console.log('[Migration] messages table rebuilt.');

      // ── Step 4: Rebuild agents_rooms ──────────────────────────────────────
      console.log('[Migration] Step 4/4: Rebuilding agents_rooms table...');
      db.exec(`DROP TABLE IF EXISTS agents_rooms_mig;`);
      db.exec(`
        CREATE TABLE agents_rooms_mig (
          agent_id INTEGER NOT NULL,
          room_id  INTEGER NOT NULL,
          no_comments INT DEFAULT 0,
          PRIMARY KEY (agent_id, room_id),
          FOREIGN KEY (agent_id) REFERENCES agents(id),
          FOREIGN KEY (room_id)  REFERENCES rooms(id)
        );
      `);

      db.exec(`
        INSERT INTO agents_rooms_mig (agent_id, room_id, no_comments)
          SELECT
            (SELECT a.id FROM agents a WHERE a.guid = ar.agent_id),
            (SELECT r.id FROM rooms  r WHERE r.guid = ar.room_id),
            COALESCE(ar.no_comments, 0)
          FROM agents_rooms ar
          WHERE
            (SELECT a.id FROM agents a WHERE a.guid = ar.agent_id) IS NOT NULL
            AND
            (SELECT r.id FROM rooms  r WHERE r.guid = ar.room_id)  IS NOT NULL;
      `);

      db.exec(`
        DROP TABLE agents_rooms;
        ALTER TABLE agents_rooms_mig RENAME TO agents_rooms;
        CREATE INDEX IF NOT EXISTS idx_agents_rooms_room_comments ON agents_rooms(room_id, no_comments);
      `);
      console.log('[Migration] agents_rooms table rebuilt.');

    } finally {
      db.pragma('foreign_keys = ON');
    }

    console.log('[Migration] INTEGER id + guid migration complete.');
    }
  } // End of guid_removed_flag check

  // ── Additive column migrations (post-INTEGER migration) ───────────────────
  // These run on fresh databases that use the new schema directly.
  // Nothing needed here currently — schema.js handles all columns.

  // ── Migration 2: Repair empty turn_order + migrate room_agents ─────────────
  // The original INTEGER migration converted turn_order by looking up agents
  // via guid. If old turn_order contained human-readable agent IDs (e.g.
  // "alalei") instead of UUIDs, no agents were found and the result was [].
  // An empty turn_order causes advanceTurn() to exit early without advancing
  // current_turn, so the same agent is triggered on every message → infinite
  // loop. This migration repairs those rooms and also brings over any memberships
  // from the legacy room_agents table that were not in agents_rooms.
  const repairFlag = db.prepare(
    `SELECT value FROM settings WHERE key = 'turn_order_repaired'`
  ).get();

  if (!repairFlag) {
    console.log('[Migration] Starting turn_order repair + room_agents merge...');

    // ── 2a: Merge legacy room_agents into agents_rooms (if table exists) ──────
    const tables = db.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='room_agents'`
    ).get();

    if (tables) {
      console.log('[Migration] Found legacy room_agents table — merging into agents_rooms...');

      // room_agents used old TEXT ids; rooms and agents now have integer ids.
      // We resolve via guid columns (rooms) and agent_id / guid (agents).
      const oldMembers = db.prepare(`SELECT room_id, agent_id FROM room_agents`).all();
      const insertMember = db.prepare(
        `INSERT OR IGNORE INTO agents_rooms (agent_id, room_id) VALUES (?, ?)`
      );

      // Build lookup helpers for the conversion
      const roomByGuid    = db.prepare(`SELECT id FROM rooms  WHERE guid     = ?`);
      const agentByGuid   = db.prepare(`SELECT id FROM agents WHERE guid     = ?`);
      const agentById     = db.prepare(`SELECT id FROM agents WHERE agent_id = ?`);

      let merged = 0;
      for (const row of oldMembers) {
        const roomRow = roomByGuid.get(row.room_id);
        if (!roomRow) continue;

        // Try guid first, then human-readable agent_id as fallback
        let agentRow = agentByGuid.get(row.agent_id) || agentById.get(row.agent_id);
        if (!agentRow) continue;

        insertMember.run(agentRow.id, roomRow.id);
        merged++;
      }
      console.log(`[Migration] Merged ${merged} room_agents entries into agents_rooms.`);
    }

    // ── 2b: Repair empty turn_order for non-free rooms ────────────────────────
    const brokenRooms = db.prepare(
      `SELECT id, turn_mode FROM rooms
       WHERE turn_mode != 'free'
         AND (turn_order IS NULL OR turn_order = '' OR turn_order = '[]')`
    ).all();

    if (brokenRooms.length > 0) {
      const getMembersStmt = db.prepare(
        `SELECT agent_id FROM agents_rooms WHERE room_id = ? ORDER BY agent_id ASC`
      );
      const repairStmt = db.prepare(
        `UPDATE rooms SET turn_order = ?, current_turn = ? WHERE id = ?`
      );

      for (const room of brokenRooms) {
        const members = getMembersStmt.all(room.id).map(r => r.agent_id);
        if (members.length >= 2) {
          repairStmt.run(JSON.stringify(members), members[0], room.id);
          console.log(
            `[Migration] Repaired room id=${room.id} turn_order=${JSON.stringify(members)}`
          );
        } else {
          console.log(
            `[Migration] Skipped room id=${room.id} — only ${members.length} member(s), cannot build turn_order`
          );
        }
      }
    } else {
      console.log('[Migration] No rooms with empty turn_order found — nothing to repair.');
    }

    db.prepare(
      `INSERT OR REPLACE INTO settings (key, value, updated_at)
       VALUES ('turn_order_repaired', '1', datetime('now'))`
    ).run();
    console.log('[Migration] turn_order repair complete.');
  }
}

module.exports = { runMigrations };
