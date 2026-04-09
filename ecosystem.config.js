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
      name: 'agent-monitor',
      script: 'python3',
      args: 'monitor/agent_monitor.py',
      cwd: APP_DIR,
      interpreter: 'none',
      watch: false,
      restart_delay: 5000,
      exp_backoff_restart_delay: 100,
      max_restarts: 10,
      autorestart: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      out_file: `${APP_DIR}/logs/agent-monitor.log`,
      error_file: `${APP_DIR}/logs/agent-monitor-error.log`
    }
  ]
};
