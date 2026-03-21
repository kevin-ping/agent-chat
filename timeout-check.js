#!/usr/bin/env node
/**
 * 超时检查脚本
 * 
 * 功能：
 * 1. 检查指定房间的讨论是否超时
 * 2. 如果超时，重置所有 agent 的 no_comments 状态
 * 3. 停止讨论，并发送 Telegram 通知给凯文哥
 * 
 * 使用：
 *   node timeout-check.js
 */

const http = require('http');

// 配置
const ROOM_ID = process.env.ROOM_ID || '493c8ac8-d743-40ea-a9b4-d630e60200d9';
const API_BASE = 'http://localhost:3210';

// 检查超时
async function checkTimeout() {
  return new Promise((resolve, reject) => {
    const url = `${API_BASE}/api/rooms/${ROOM_ID}/timeout-check`;
    
    http.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const result = JSON.parse(data);
          resolve(result);
        } catch (e) {
          reject(e);
        }
      });
    }).on('error', reject);
  });
}

// 发送 Telegram 通知（通过 OpenClaw webhook）
async function sendAlert(message) {
  // 这里需要调用 OpenClaw 的 webhook 发送消息
  // 具体实现需要根据你的 OpenClaw 配置调整
  console.log(`🚨 发送 Telegram 警报：${message}`);
  // TODO: 实现 Telegram 通知逻辑
}

// 主函数
async function main() {
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
    process.exit(1);
  }
}

// 如果直接运行此脚本
if (require.main === module) {
  main();
}

module.exports = { checkTimeout, sendAlert };
