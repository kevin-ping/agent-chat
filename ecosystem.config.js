require('dotenv').config();

const APP_DIR = process.env.APP_DIR || '/var/www/agent-chat';

module.exports = {
  apps: [{
      name: 'agent-chat-server',
      script: 'server.js',
      cwd: APP_DIR,
      watch: false,
      restart_delay: 100,
      exp_backoff_restart_delay: 100,
      max_restarts: 10,
      autorestart: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      out_file: `${APP_DIR}/logs/server.log`,
      error_file: `${APP_DIR}/logs/server-error.log`
    },
    {
      name: 'room-trigger',
      script: './triggers/room-trigger.js',
      cwd: APP_DIR,
      watch: false,
      restart_delay: 100,
      exp_backoff_restart_delay: 100,
      max_restarts: 10,
      autorestart: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      out_file: `${APP_DIR}/logs/room-trigger.log`,
      error_file: `${APP_DIR}/logs/room-trigger-error.log`,
      env: {
        MY_AGENT_ID: process.env.MY_AGENT_ID,
        WS_URL: process.env.WS_URL,
        WEBHOOK_TOKEN: process.env.WEBHOOK_TOKEN
      }
    },
    // Add additional webhook-trigger processes here if needed:
    // {
    //   name: 'webhook-trigger-agent',
    //   script: './triggers/webhook-trigger.js',
    //   cwd: APP_DIR,
    //   watch: false,
    //   restart_delay: 100,
    //   exp_backoff_restart_delay: 100,
    //   max_restarts: 10,
    //   autorestart: true,
    //   out_file: `${APP_DIR}/logs/agent-trigger.log`,
    //   error_file: `${APP_DIR}/logs/agent-trigger-error.log`
    // },
    {
      name: 'timeout-daemon',
      script: 'timeout-daemon.js',
      cwd: APP_DIR,
      watch: false,
      restart_delay: 100,
      exp_backoff_restart_delay: 100,
      max_restarts: 10,
      autorestart: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      out_file: `${APP_DIR}/logs/timeout-daemon.log`,
      error_file: `${APP_DIR}/logs/timeout-daemon-error.log`
    }
  ]
};
