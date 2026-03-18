module.exports = {
  apps: [
    {
      name: "ws-alalei",
      script: "ws-listener.js",
      cwd: "/var/www/agent-chat",
      env: {
        MY_AGENT_ID: "alalei",
        ROOM_ID: "04d23d77-3a39-4ad6-b6dc-227f4baed930",
        WS_URL: "ws://localhost:3210/ws"
      },
      watch: false,
      restart_delay: 1000,
      exp_backoff_restart_delay: 100,
      max_restarts: 10,
      autorestart: true,
      out_file: "/tmp/ws-alalei-pm2.log",
      error_file: "/tmp/ws-alalei-pm2-error.log"
    },
    {
      name: "ws-ximige",
      script: "ws-listener.js",
      cwd: "/var/www/agent-chat",
      env: {
        MY_AGENT_ID: "ximige",
        ROOM_ID: "04d23d77-3a39-4ad6-b6dc-227f4baed930",
        WS_URL: "ws://localhost:3210/ws"
      },
      watch: false,
      restart_delay: 1000,
      exp_backoff_restart_delay: 100,
      max_restarts: 10,
      autorestart: true,
      out_file: "/tmp/ws-ximige-pm2.log",
      error_file: "/tmp/ws-ximige-pm2-error.log"
    }
  ]
};
