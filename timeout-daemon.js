#!/usr/bin/env node
/**
 * 超时检查守护进程
 * 
 * 功能：
 * - 每 30 秒检查一次讨论是否超时
 * - 如果超时，自动重置并发送通知
 * 
 * 使用：
 *   pm2 start timeout-daemon.js --name timeout-daemon
 */

require('dotenv').config();
const { checkTimeout, sendAlert } = require('./timeout-check');

const CHECK_INTERVAL = 30000; // 30 秒

async function main() {
  console.log(`timeout-daemon start interval=${CHECK_INTERVAL / 1000}s`);

  setInterval(async () => {
    try {
      const { rooms, anyReset } = await checkTimeout();

      if (rooms.length === 0) {
        console.log('ok no active discussions');
        return;
      }

      for (const r of rooms) {
        if (r.error) {
          console.error(`check failed room=${r.roomId}: ${r.error}`);
        } else if (r.shouldReset) {
          console.log(`timeout reset room=${r.roomName || r.roomId}: ${r.reason}`);
          await sendAlert(`讨论超时，已自动重置 [${r.roomName || r.roomId}]：${r.reason}`);
        } else {
          const remaining = Math.floor(r.timeoutRemaining != null ? r.timeoutRemaining : 0);
          console.log(`ok room=${r.roomName || r.roomId} remaining=${remaining}s`);
        }
      }
    } catch (error) {
      console.error(`check failed: ${error.message}`);
    }
  }, CHECK_INTERVAL);
}

main();
