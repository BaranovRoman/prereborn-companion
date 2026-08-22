// WK-80 - `root` resolves through the `current` symlink
// (releases/<sha> -> current), not a fixed source-tree path, so a deploy
// only has to atomically repoint one symlink for both PM2 apps to pick up
// the new release on reload. DEPLOY_ROOT is overridable via env for local
// dry-run testing (see scripts/test-release-sh.sh) - production never sets
// it, so it defaults to the real path unchanged.
const deployRoot = process.env.DEPLOY_ROOT || "/var/www/www-root/data/www/prereborn.ru";
const root = `${deployRoot}/current`;
const sharedLogs = `${deployRoot}/shared/logs`;

module.exports = {
  apps: [
    {
      name: "prereborn-api",
      cwd: `${root}/api`,
      script: "dist/index.js",
      instances: 1,
      exec_mode: "fork",
      env: {
        NODE_ENV: "production",
        PORT: process.env.API_PORT || "5102"
      },
      error_file: `${sharedLogs}/api-error.log`,
      out_file: `${sharedLogs}/api-out.log`,
      time: true,
      max_memory_restart: "500M",
      kill_timeout: 5000
    },
    {
      name: "prereborn-web",
      // WK-80 - `output: "standalone"` (apps/web/next.config.js) replaces
      // `next start` with a generated server.js that reads PORT/HOSTNAME
      // from env instead of `-p`/`-H` CLI args - see
      // docs/research/wk-80-build-outside-production.md #4.
      cwd: `${root}/web/apps/web`,
      script: "server.js",
      instances: 1,
      exec_mode: "fork",
      env: {
        NODE_ENV: "production",
        PORT: process.env.WEB_PORT || "5100",
        HOSTNAME: "127.0.0.1",
        BACKEND_URL: "http://127.0.0.1:" + (process.env.API_PORT || "5102")
      },
      error_file: `${sharedLogs}/web-error.log`,
      out_file: `${sharedLogs}/web-out.log`,
      time: true,
      max_memory_restart: "1G",
      kill_timeout: 5000
    }
  ]
};
