module.exports = {
  apps: [
    {
      name: 'ai-agent-server',
      script: './dist/index.js',
      cwd: '/opt/ai-agent-server',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_memory_restart: '400M',
      watch: false,
      max_restarts: 10,
      restart_delay: 5000,
      env: {
        NODE_ENV: 'production',
        PORT: 3000,
      },
      env_development: {
        NODE_ENV: 'development',
        PORT: 3000,
      },
      error_logger: './logs/error.log',
      out_logger: './logs/out.log',
      merge_logs: true,
      time: true,
    },
  ],
};
