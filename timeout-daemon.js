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

const { checkTimeout, sendAlert } = require('./timeout-check');

const CHECK_INTERVAL = 30000; // 30 秒

async function main() {
  console.log('🔍 超时检查守护进程已启动');
  console.log(`   检查间隔：${CHECK_INTERVAL / 1000} 秒`);
  
  setInterval(async () => {
    try {
      const result = await checkTimeout();
      
      if (result.shouldReset) {
        console.log(`⏰ 讨论超时！${result.reason}`);
        console.log(`   重置详情：`, result.resetDetails);
        
        // 发送 Telegram 通知
        await sendAlert(`讨论超时，已自动重置：${result.reason}`);
      } else {
        console.log(`✅ 讨论进行中，剩余时间：${Math.floor(300 - result.elapsed)}秒`);
      }
    } catch (error) {
      console.error('❌ 超时检查失败：', error);
    }
  }, CHECK_INTERVAL);
}

main();
