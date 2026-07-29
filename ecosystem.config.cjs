const root = "/var/www/www-root/data/www/prereborn.ru";

module.exports = {
  apps: [
    {
      name: "prereborn-api",
      cwd: `${root}/apps/api`,
      script: "dist/index.js",
      instances: 1,
      exec_mode: "fork",
      env: {
        NODE_ENV: "production",
        PORT: "5102"
      },
      error_file: `${root}/logs/api-error.log`,
      out_file: `${root}/logs/api-out.log`,
      time: true,
      max_memory_restart: "500M",
      kill_timeout: 5000
    },
    {
      name: "prereborn-web",
      cwd: `${root}/apps/web`,
      script: "node_modules/next/dist/bin/next",
      args: ["start", "-H", "127.0.0.1", "-p", "5100"],
      instances: 1,
      exec_mode: "fork",
      env: {
        NODE_ENV: "production",
        BACKEND_URL: "http://127.0.0.1:5102"
      },
      error_file: `${root}/logs/web-error.log`,
      out_file: `${root}/logs/web-out.log`,
      time: true,
      max_memory_restart: "1G",
      kill_timeout: 5000
    }
  ]
};
