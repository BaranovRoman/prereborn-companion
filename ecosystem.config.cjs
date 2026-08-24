// WK-80 - `root` resolves through the `current` symlink
// (releases/<sha> -> current), not a fixed source-tree path, so a deploy
// only has to atomically repoint one symlink for both PM2 apps to pick up
// the new release on reload. DEPLOY_ROOT is overridable via env for local
// dry-run testing (see scripts/test-release-sh.sh) - production never sets
// it, so it defaults to the real path unchanged.
const deployRoot = process.env.DEPLOY_ROOT || "/var/www/www-root/data/www/prereborn.ru";
const root = `${deployRoot}/current`;
const sharedLogs = `${deployRoot}/shared/logs`;
// WK-88 follow-up (production regression) - captured here, at ecosystem
// file evaluation time, not left to child-process env inheritance: PM2's
// long-lived daemon (not the ad-hoc `pm2 start` CLI invocation) is what
// actually forks app processes, and its own env doesn't automatically pick
// up a shell-exported var from a later CLI call. Baking the value into the
// `env:` objects below at require()-time (this file IS require()'d by the
// CLI invocation that has PREREBORN_RELEASE_SHA in its shell env - see
// release.sh) sidesteps that entirely. Both apps get it from this single
// shared const, guaranteeing they always agree on which release they're
// reporting - see release.sh's health_check() for how this gets verified.
const releaseSha = process.env.PREREBORN_RELEASE_SHA || "";
// WK-96 - see release.sh's header comment: two artifacts can share the same
// commit SHA (build-time-only inputs like the resolved Companion download
// version/URL aren't part of the git tree), so releaseSha alone can no
// longer prove which specific artifact is running - PREREBORN_RELEASE_BUILD_ID
// (first 12 hex chars of the artifact tarball's own sha256, set by
// release.sh) disambiguates. Same require()-time capture reasoning as
// releaseSha above.
const releaseBuildId = process.env.PREREBORN_RELEASE_BUILD_ID || "";

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
        PORT: process.env.API_PORT || "5102",
        PREREBORN_RELEASE_SHA: releaseSha,
        PREREBORN_RELEASE_BUILD_ID: releaseBuildId
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
        BACKEND_URL: "http://127.0.0.1:" + (process.env.API_PORT || "5102"),
        PREREBORN_RELEASE_SHA: releaseSha,
        PREREBORN_RELEASE_BUILD_ID: releaseBuildId
      },
      error_file: `${sharedLogs}/web-error.log`,
      out_file: `${sharedLogs}/web-out.log`,
      time: true,
      max_memory_restart: "1G",
      kill_timeout: 5000
    }
  ]
};
