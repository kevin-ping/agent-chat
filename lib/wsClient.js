'use strict';
const WebSocket = require('ws');

const HEARTBEAT_INTERVAL = 30_000; // 每 30 秒发一次 ping
const HEARTBEAT_TIMEOUT  = 10_000; // 10 秒内未收到 pong 则断线重连

/**
 * 创建一个可自动重连的 WebSocket 客户端。
 * @param {object} opts
 * @param {string} opts.url        WebSocket URL
 * @param {function} opts.onMessage  收到消息时的回调 (parsed JSON object)
 * @param {function} [opts.onConnect] 成功连接时的回调
 * @returns {{ close: function }}
 */
function createWsClient({ url, onMessage, onConnect }) {
  let ws;
  let reconnectDelay = 3000;
  let closed = false;

  function connect() {
    if (closed) return;
    console.log(`🔌 Connecting to ${url}...`);
    ws = new WebSocket(url);

    ws.on('open', () => {
      console.log('✅ WebSocket connected!');
      reconnectDelay = 3000;
      if (onConnect) onConnect();

      // 启动心跳：每 30 秒 ping 一次，10 秒无 pong 则主动断线触发重连
      const hbTimer = setInterval(() => {
        if (ws.readyState !== WebSocket.OPEN) return;

        let pongReceived = false;
        ws.once('pong', () => { pongReceived = true; });
        ws.ping();

        setTimeout(() => {
          if (!pongReceived) {
            console.warn('💔 Heartbeat timeout, reconnecting...');
            ws.terminate(); // 触发 close 事件 → 自动重连
          }
        }, HEARTBEAT_TIMEOUT);
      }, HEARTBEAT_INTERVAL);

      ws.once('close', () => clearInterval(hbTimer));
    });

    ws.on('message', (data) => {
      try {
        onMessage(JSON.parse(data.toString()));
      } catch (e) {
        console.error('❌ Parse error:', e.message);
      }
    });

    ws.on('close', () => {
      if (closed) return;
      console.log('🔌 WebSocket disconnected, reconnecting...');
      setTimeout(connect, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, 30000);
    });

    ws.on('error', (err) => {
      console.error('❌ WebSocket error:', err.message);
    });
  }

  connect();

  return {
    close() {
      closed = true;
      if (ws) ws.close();
    }
  };
}

module.exports = { createWsClient };
