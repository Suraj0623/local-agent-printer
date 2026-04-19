module.exports = {
  apps: [{
    name:          "print-agent",
    script:        "src/agent.js",
    instances:     1,
    exec_mode:     "fork",
    watch:         false,
    restart_delay: 5000,
    max_restarts:  10,

    env: {
      NODE_ENV: "development",
    },
    env_production: {
      NODE_ENV: "production",
    },

    out_file:        "./logs/pm2-out.log",
    error_file:      "./logs/pm2-error.log",
    merge_logs:      true,
    log_date_format: "YYYY-MM-DD HH:mm:ss",
  }],
};
