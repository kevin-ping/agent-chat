#!/usr/bin/env node
/**
 * 超时检查脚本
 *
 * 功能：
 * 1. 检查所有进行中讨论的房间是否超时
 * 2. 如果超时，重置所有 agent 的 no_comments 状态并停止讨论
 * 3. 发送 Telegram 通知给管理员
 *
 * 使用：
 *   node timeout-check.js
 */

const http = require('http');

const API_BASE = process.env.API_BASE || 'http://localhost:3210';

// 通用 GET helper
function httpGet(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

// 获取所有房间列表
async function listRooms() {
  const result = await httpGet(`${API_BASE}/api/rooms`);
  // API returns { rooms: [...] } or just an array
  return Array.isArray(result) ? result : (result.rooms || []);
}

// 检查单个房间的超时状态
async function checkRoomTimeout(roomId) {
  return httpGet(`${API_BASE}/api/rooms/${roomId}/timeout-check`);
}

// 检查所有进行中讨论的房间
async function checkTimeout() {
  const rooms = await listRooms();
  const activeRooms = rooms.filter(r => r.discussion === 1);

  if (activeRooms.length === 0) {
    return { rooms: [], anyReset: false };
  }

  const results = await Promise.all(
    activeRooms.map(async (room) => {
      try {
        const result = await checkRoomTimeout(room.id);
        return { roomId: room.id, roomName: room.name, ...result };
      } catch (err) {
        return { roomId: room.id, roomName: room.name, error: err.message };
      }
    })
  );

  const anyReset = results.some(r => r.shouldReset);
  return { rooms: results, anyReset };
}

// 发送 Telegram 通知（通过 OpenClaw webhook）
async function sendAlert(message) {
  console.log(`🚨 发送 Telegram 警报：${message}`);
  // TODO: 实现 Telegram 通知逻辑
}

// 主函数
async function main() {
  try {
    const { rooms, anyReset } = await checkTimeout();

    if (rooms.length === 0) {
      console.log('✅ 无进行中的讨论');
      return;
    }

    for (const r of rooms) {
      if (r.error) {
        console.error(`❌ 房间 ${r.roomName || r.roomId} 检查失败: ${r.error}`);
      } else if (r.shouldReset) {
        console.log(`⏰ 讨论超时！房间: ${r.roomName || r.roomId} — ${r.reason}`);
        console.log(`   重置详情：`, r.resetDetails);
        await sendAlert(`讨论超时，已自动重置 [${r.roomName || r.roomId}]：${r.reason}`);
      } else {
        const remaining = Math.floor(r.timeoutRemaining != null ? r.timeoutRemaining : 0);
        console.log(`✅ 房间 ${r.roomName || r.roomId} 讨论进行中，剩余时间：${remaining}秒`);
      }
    }
  } catch (error) {
    console.error('❌ 超时检查失败：', error);
    process.exit(1);
  }
}

// 如果直接运行此脚本
if (require.main === module) {
  main();
}

module.exports = { checkTimeout, checkRoomTimeout, sendAlert };
