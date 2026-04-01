#!/usr/bin/env node
'use strict';

/**
 * 修复 messages 表中错误的 GUID 值
 *
 * 此脚本会修复 guid 列中只有单个字符或数字的记录，
 * 为这些记录生成正确的 UUID v4 格式。
 */

const { v4: uuidv4 } = require('uuid');
const db = require('../src/db');

console.log('[Fix Message GUIDs] Starting...');

// 检查有多少条记录需要修复
const badGuids = db.prepare(`
  SELECT id, guid, room_id FROM messages
  WHERE length(guid) < 36
`).all();

if (badGuids.length === 0) {
  console.log('[Fix Message GUIDs] No bad GUIDs found. All messages are OK.');
  process.exit(0);
}

console.log(`[Fix Message GUIDs] Found ${badGuids.length} messages with bad GUIDs:`);
badGuids.slice(0, 10).forEach(m => {
  console.log(`  - Message id=${m.id}, bad guid="${m.guid}", room_id=${m.room_id}`);
});
if (badGuids.length > 10) {
  console.log(`  ... and ${badGuids.length - 10} more`);
}

// 开始修复
const fixGuids = db.transaction(() => {
  const updateStmt = db.prepare('UPDATE messages SET guid = ? WHERE id = ?');

  for (const msg of badGuids) {
    const newGuid = uuidv4();
    updateStmt.run(newGuid, msg.id);
    console.log(`[Fix Message GUIDs] Fixed message id=${msg.id}: "${msg.guid}" -> "${newGuid}"`);
  }
});

try {
  fixGuids();
  console.log(`[Fix Message GUIDs] Successfully fixed ${badGuids.length} messages.`);

  // 验证修复结果
  const remainingBad = db.prepare(`
    SELECT COUNT(*) as count FROM messages WHERE length(guid) < 36
  `).get();
  console.log(`[Fix Message GUIDs] Remaining bad GUIDs: ${remainingBad.count}`);

  process.exit(0);
} catch (e) {
  console.error('[Fix Message GUIDs] Error:', e.message);
  process.exit(1);
}
