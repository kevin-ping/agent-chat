module.exports = {
  apps: [
    {
      name: "agent-chat-server",
      script: "server.js",
      cwd: "/var/www/agent-chat",
      watch: false,
      restart_delay: 1000,
      exp_backoff_restart_delay: 100,
      max_restarts: 10,
      autorestart: true,
      out_file: "/var/www/agent-chat/logs/server.log",
      error_file: "/var/www/agent-chat/logs/server-error.log"
    },
    {
      name: "webhook-trigger-alalei",
      script: "webhook-trigger.js",
      cwd: "/var/www/agent-chat",
      env: {
        MY_AGENT_ID: "alalei",
        ROOM_ID: "493c8ac8-d743-40ea-a9b4-d630e60200d9",
        WS_URL: "ws://localhost:3210/ws",
        GATEWAY_URL: "http://127.0.0.1:18789",
        WEBHOOK_TOKEN: "my-secret-token"
      },
      watch: false,
      restart_delay: 1000,
      exp_backoff_restart_delay: 100,
      max_restarts: 10,
      autorestart: true,
      out_file: "/var/www/agent-chat/logs/alalei-trigger.log",
      error_file: "/var/www/agent-chat/logs/alalei-trigger-error.log"
    },
    {
      name: "webhook-trigger-ximige",
      script: "webhook-trigger.js",
      cwd: "/var/www/agent-chat",
      env: {
        MY_AGENT_ID: "ximige",
        ROOM_ID: "493c8ac8-d743-40ea-a9b4-d630e60200d9",
        WS_URL: "ws://localhost:3210/ws",
        GATEWAY_URL: "http://127.0.0.1:18789",
        WEBHOOK_TOKEN: "my-secret-token"
      },
      watch: false,
      restart_delay: 1000,
      exp_backoff_restart_delay: 100,
      max_restarts: 10,
      autorestart: true,
      out_file: "/var/www/agent-chat/logs/ximige-trigger.log",
      error_file: "/var/www/agent-chat/logs/ximige-trigger-error.log"
    },
    {
      name: "timeout-daemon",
      script: "timeout-daemon.js",
      cwd: "/var/www/agent-chat",
      watch: false,
      restart_delay: 1000,
      exp_backoff_restart_delay: 100,
      max_restarts: 10,
      autorestart: true,
      out_file: "/var/www/agent-chat/logs/timeout-daemon.log",
      error_file: "/var/www/agent-chat/logs/timeout-daemon-error.log"
    }
  ]
};
