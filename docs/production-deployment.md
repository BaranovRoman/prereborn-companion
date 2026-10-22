# Production deployment

Production deploys automatically after the `CI` workflow succeeds for `main`.
GitHub Actions builds a versioned, self-contained release artifact on the
runner itself (see `scripts/build-release-artifact.sh`) - the production
server never runs `pnpm install`, `next build`, or `tsc`. The artifact is
uploaded over SSH, then `release.sh` on the server extracts it into
`releases/<sha>-<build_id>/`, applies database migrations against its
compiled output, atomically switches the `current` symlink, reloads PM2, and
runs health checks - automatically rolling `current` back to the previous
release if the new one doesn't come up healthy. See
`docs/research/wk-80-build-outside-production.md` for the full design and
`scripts/test-release-sh.sh` for a local dry run of the whole flow (extract,
migrate, atomic switch, health check, automatic rollback) against a
throwaway Postgres database and real PM2, no production server involved.

**WK-96 - release identity is `<sha>-<build_id>`, not just `<sha>`:** the web
artifact bakes in build-time-only inputs that aren't part of the git tree
(currently the Companion download version/URL, resolved live from GitHub's
"latest release" - see `scripts/resolve-companion-release.sh`), so two
builds of the identical commit can produce genuinely different artifacts.
`build_id` is the first 12 hex chars of the artifact tarball's own sha256
(already computed by `build-release-artifact.sh`, no extra build step) -
`release.sh` only treats a deploy as "already current" (safe no-op) when
both the commit SHA *and* the artifact content match; a same-SHA deploy with
different build inputs is a genuinely new release and goes live. `/api/health`
(`releaseBuildId`) and the web root response (`X-Release-Build-Id` header)
expose this alongside the existing `releaseSha`/`X-Release-Sha` (unchanged
meaning: the git commit a release was built from) so the deploy pipeline's
health check can confirm the exact artifact just switched to is the one
actually serving, not just any artifact of the right commit.

## Production layout

```
/var/www/www-root/data/www/prereborn.ru/
├── releases/<sha>-<build_id>/   # one directory per deployed artifact - web/api build output + node_modules
├── current -> releases/<sha>-<build_id>   # atomically repointed on every successful deploy
├── shared/
│   ├── .env                    # written by "Install production environment" - never per-release
│   └── logs/                   # PM2 error/out logs - 14 days, see "Logs and retention"
├── apps/api/uploads/       # user-uploaded files (UPLOADS_DIR) - unchanged path, see below
└── incoming/               # scratch space for the just-uploaded artifact + release.sh
```

`nginx.production.conf` is untouched by this layout: every route proxies to
the PM2-managed Node processes on fixed loopback ports (5100/5102), so
nginx never needs to know which release is current - only
`ecosystem.config.cjs` (via the `current` symlink) and `release.sh` do.
`apps/api/src/config/env.ts`'s `UPLOADS_DIR` deliberately keeps uploaded
files out of the versioned `releases/<sha>-<build_id>/` tree entirely - `process.cwd()`
inside a release resolves to that release's own directory, which would
otherwise silently scope user uploads to whichever release happened to be
current when they were uploaded, and orphan them on the next switch.
`UPLOADS_DIR` points at the *same* absolute path (`apps/api/uploads/`,
directly under the deploy root, not under `releases/`) that both
`nginx.production.conf`'s `/uploads/` alias and pre-WK-80 deploys already
used - deliberately not moved under `shared/`, so this migration needed
neither an nginx config change nor a data migration for already-uploaded
files.

## One-time server bootstrap

Create the database role and database:

```bash
sudo -u postgres psql
```

```sql
CREATE USER ramzes2045 WITH PASSWORD 'REPLACE_WITH_A_STRONG_PASSWORD';
CREATE DATABASE prereborn OWNER ramzes2045;
\q
```

Create the application directory and grant it to the SSH deployment user:

```bash
sudo mkdir -p /var/www/www-root/data/www/prereborn.ru
sudo chown -R www-root:www-root /var/www/www-root/data/www/prereborn.ru
```

Install Node.js 20+ and PM2 on the server (Corepack/pnpm are no longer
needed there - the release artifact ships its own `node_modules`, and
production never runs `pnpm install`/`next build`/`tsc`; see WK-80). Confirm:

```bash
node --version
pm2 --version
```

Do not create `.env` manually. GitHub Actions assembles it from separate
protected secrets and writes it with mode `600` during every deployment.

## GitHub environment and secrets

In repository settings, create the `production` environment. Add:

- `PRODUCTION_SSH_HOST`: `91.240.85.53`
- `PRODUCTION_SSH_PORT`: SSH port, normally `22`
- `PRODUCTION_SSH_USER`: SSH login that can write to the application directory
- `PRODUCTION_SSH_PRIVATE_KEY`: private Ed25519 key used only by Actions
- `PRODUCTION_SSH_KNOWN_HOSTS`: pinned server host-key line
- `PRODUCTION_DATABASE_URL`: PostgreSQL connection string
- `PRODUCTION_STREAM_JWT_SECRET`: stream authentication signing secret
- `ADMIN_EMAILS`: optional comma-separated admin allowlist for `/admin`;
  empty just means the admin panel is unreachable, it does not block startup
- `OPENDOTA_API_KEY`: optional OpenDota key
- `TWITCH_CLIENT_ID`: optional Twitch application ID
- `TWITCH_CLIENT_SECRET`: optional Twitch application secret

Generate the JWT value locally:

```bash
openssl rand -hex 64
```

Set `PRODUCTION_DATABASE_URL` to:

```text
postgresql://ramzes2045:REPLACE_WITH_DATABASE_PASSWORD@127.0.0.1:5432/prereborn
```

Set `PRODUCTION_STREAM_JWT_SECRET` to the generated value. Optional integration
secrets may be absent initially. Adding or rotating one secret only requires
updating that single GitHub Environment secret and rerunning the deployment.

The workflow combines secrets with stable public settings, transfers the result
over SSH without printing it and creates the runtime `.env` automatically. The
public web build also receives
`NEXT_PUBLIC_MEDIA_BASE_URL=https://prereborn.ru/media`; media itself is deployed
separately according to `docs/media-hosting.md`.

Generate a dedicated deployment key locally:

```bash
ssh-keygen -t ed25519 -C "github-actions-prereborn" -f prereborn_deploy
```

Append `prereborn_deploy.pub` to the deployment user's
`~/.ssh/authorized_keys`. Put the complete private `prereborn_deploy` file in
`PRODUCTION_SSH_PRIVATE_KEY`.

Obtain the known-hosts value from a trusted machine and verify its fingerprint
against the server before saving it:

```bash
ssh-keyscan -p 22 -H 91.240.85.53
```

## First deployment

Commit and push the deployment files to `main`. CI runs first. A successful CI
run triggers `Deploy production` automatically. Follow both workflows in the
repository Actions page.

Verify:

```bash
pm2 list
curl -i http://127.0.0.1:5102/api/health
curl -I http://127.0.0.1:5100
curl -I https://prereborn.ru
```

Enable PM2 startup once:

```bash
pm2 startup
```

Run the command printed by PM2 and then:

```bash
pm2 save
```

`release.sh` remains available as an emergency manual fallback - run it from
`/var/www/www-root/data/www/prereborn.ru` with the target commit SHA and the
path to an already-uploaded artifact tarball:

```bash
bash release.sh <sha> <path-to-release.tar.gz>
```

It expects `<path>.sha256` next to the tarball and `shared/.env` to already
exist. See `release.sh`'s own header comment for the full env var overrides
(`DEPLOY_ROOT`, `PM2_BIN`, etc.) and
`docs/research/wk-80-build-outside-production.md` for the design this
replaced (the old `deploy.sh`, which built on the server, is removed).

## Adding or changing an environment variable

See [docs/operations/production-env.md](operations/production-env.md) for
the full variable inventory, the required/optional/secret classification,
and the exact steps to wire a new variable into the deploy workflow. The
`.env` written on the server is fully regenerated from
`deploy-production.yml` on every deploy — adding a variable to
`.env.example` alone does not get it to production.

## Logs and retention

WK-196. Every log that can hold personal data is kept **at most 14 days** and
removed automatically; overlay tokens and OAuth callback parameters don't
reach the access log.

| Log | Where | Retention | Config |
|---|---|---|---|
| nginx access/error | `/var/www/httpd-logs/prereborn.ru.*.log`, archives in `/var/www/www-root/data/logs/` | daily, `rotate 10` (~11 days) | ISPmanager (`/etc/logrotate.d/web/prereborn.ru`, generated by the panel) |
| PM2 (API + web), daemon runs as root, files `root:root` | `shared/logs/{api,web}-{out,error}.log` | daily, 14 days (+ early at 100M) | `deploy/logrotate/prereborn-pm2` → `/etc/logrotate.d/prereborn-pm2` |
| PostgreSQL | `/var/log/postgresql/*.log` | daily, 14 days | `deploy/logrotate/postgresql-common` → `/etc/logrotate.d/postgresql-common` |

### What is protected, and how

- **Access log** (`log_format prereborn_masked`,
  `deploy/nginx/prereborn-logging.conf`): the path is taken from the
  normalized `$uri`, and the segment after `overlay/` becomes `[token]`
  (case and repeated slashes don't matter). The query string is never
  logged on any URL, only a `?[redacted]` marker, so OAuth `code`/`state`,
  Steam `openid.*` and any future parameter are covered without a per-route
  list. Referer is reduced to its origin. Request/upstream timing and the
  upstream status are appended.
- **Error log**: nginx's error-log format is fixed and always includes the
  request line, the upstream URL and the Referer. For the two overlay routes
  (`location ~* ^/overlay/`, `~* ^/api/stream/overlay/`) the level is
  `crit`. crit/alert/emerg are still logged; error/warn/notice entries for
  those requests are not. The same upstream failures still show up in full
  on every other route (same processes), and the masked access log keeps
  status, `us=` (upstream status) and timings for overlay requests.
  `/media/` and `/uploads/` have `log_not_found off`: a missing file is
  still a 404 in the access log, but no error-log line carries the
  request's Referer.
- **Referer at the source**: the overlay page is served with
  `Referrer-Policy: strict-origin` (`apps/web/next.config.js`), so its own
  requests (API polling, `/_next/static`, `/media`) send only
  `https://prereborn.ru`.
- **API log**: `requestLogger` masks the overlay token (only 5xx lines are
  logged at the production `info` level, and query strings never). OAuth
  controllers log neither `code`/`state` nor tokens.
- **PostgreSQL**: queries are parameterized, so `STATEMENT` lines contain
  only `$1` placeholders, and parameter values are not logged on errors
  (`log_parameter_max_length_on_error=0`, the default). `DETAIL` does carry
  values (`Key (email)=(…) already exists`): `log_error_verbosity=terse`
  removes it. `log_min_error_statement` stays at `error`: it adds no values,
  only the SQL text needed for diagnostics.

### Residual risks

- A client that ignores `Referrer-Policy` and loads the overlay page, then
  hits an upstream error on another route: that error-log line contains the
  overlay URL as `referrer`. All current browsers and OBS's CEF honor the
  policy.
- A request to Next's own `/api` rewrite with the API down: Next logs
  `Failed to proxy <full URL>` to `web-error.log`. In production nginx sends
  every `/api` request straight to the API, so external traffic doesn't
  take this path.
- PostgreSQL's primary error message can quote an input value
  (`invalid input syntax for type integer: "…"`). No setting removes it
  without dropping errors altogether; it is covered by the 14-day retention.
- Removing the cause, the token in the URL path of the legacy public
  overlay, is WK-198. The current Companion overlay is local
  (`http://127.0.0.1:3666/overlay`) and has no token.

### ISPmanager

ISPmanager regenerates both the vhost and `/etc/logrotate.d/web/prereborn.ru`
from the panel. The masking only depends on the vhost's `access_log ...
prereborn_masked;` line and the two overlay locations. If the panel ever
rewrites the vhost from its template (site settings changed, certificate
reissued), those lines can silently disappear. After any change to the
site in the panel:

```bash
nginx -T 2>/dev/null | grep -cE 'access_log .*prereborn\.ru\.access\.log prereborn_masked'  # must be 1
nginx -T 2>/dev/null | grep -c 'error.log crit'                                             # must be 2
```

Leave the ISPmanager rotation at ≤ 14 days if the site's log settings
change.

### Production procedure

Every step runs as root on the server. Each one waits for an explicit go
from the owner. root's login shell on the server is zsh, which doesn't
word-split `$VAR`: run multi-command snippets through `ssh kiwi 'bash -s' <<'EOF'`.

**0. Read-only pre-checks** (nothing changes, no log contents are read):

```bash
nginx -v
nginx -T 2>/dev/null | grep -nE 'include .*conf\.d|log_format|access_log|error_log|merge_slashes'
grep -l 'server_name prereborn.ru' /etc/nginx/vhosts/*/*.conf     # the active vhost file
cat /etc/logrotate.d/web/prereborn.ru /etc/logrotate.d/postgresql-common
systemctl list-timers logrotate.timer 2>/dev/null || ls -l /etc/cron.daily/logrotate
sudo -u postgres psql -Atc "SELECT name || '=' || setting FROM pg_settings WHERE name IN
  ('logging_collector','log_destination','log_directory','log_min_error_statement',
   'log_error_verbosity','log_parameter_max_length_on_error','log_line_prefix')"
ls /var/www/www-root/data/www/prereborn.ru/shared/logs | wc -l; du -sh /var/www/www-root/data/www/prereborn.ru/shared/logs; df -h /
```

Expected: `conf.d/*.conf` is included at http level, and
`logging_collector=off` (Debian's pg_ctlcluster writes to
`/var/log/postgresql/`, which logrotate rotates with copytruncate). With
`logging_collector=on` PostgreSQL rotates its own files in `log_directory`:
in that case the logrotate file doesn't cover them, so stop and
reconsider.

**1. Back up the current configs**

```bash
B=/root/wk196-backup-$(date +%F); mkdir -m 700 "$B"
V=$(grep -l 'server_name prereborn.ru' /etc/nginx/vhosts/*/*.conf)
cp -a "$V" /etc/logrotate.d/postgresql-common "$B"/
nginx -T > "$B/nginx-T.txt" 2>&1
sudo -u postgres psql -Atc "SELECT name || '=' || setting FROM pg_settings WHERE name IN ('log_min_error_statement','log_error_verbosity')" > "$B/pg-settings.txt"
```

**2. Install the configs that change nothing on their own**

```bash
install -m 0644 deploy/nginx/prereborn-logging.conf /etc/nginx/conf.d/prereborn-logging.conf
nginx -t                                   # the format is defined, nothing uses it yet
install -m 0644 deploy/logrotate/prereborn-pm2 /etc/logrotate.d/prereborn-pm2
diff "$B/postgresql-common" deploy/logrotate/postgresql-common   # only weekly/rotate/maxage should differ
install -m 0644 deploy/logrotate/postgresql-common /etc/logrotate.d/postgresql-common
logrotate -d /etc/logrotate.d/prereborn-pm2 /etc/logrotate.d/postgresql-common   # dry run, no "error:" lines
```

**3. Merge the PR**: the normal deploy ships `merge_logs`, the API masking
and the overlay `Referrer-Policy`. `release.sh` does `pm2 delete` + `start`
(a few seconds' gap, as with every deploy). After it:
`ls -l --time-style=long-iso shared/logs/*.log` shows fresh `api-out.log`,
`api-error.log`, `web-out.log` and `web-error.log`, and no new `*-<id>.log`
files.

**4. Switch the vhost**: through ISPmanager's own site config editor
(Сайты → prereborn.ru → Конфигурационные файлы, nginx), so the panel knows
about the change. The changes are the `access_log ... prereborn_masked`,
the two overlay locations and `log_not_found off`. From the shell the
same editor is the `webdomain.plain` function (field `nginx_data`):

```bash
# 4a. validate the new vhost with the whole real config before saving: a
# throwaway main file next to nginx.conf (relative includes such as
# fastcgi_params resolve from /etc/nginx), nothing includes it
for f in /etc/nginx/vhosts/*/*.conf; do [ "$f" = /etc/nginx/vhosts/www-root/prereborn.ru.conf ] || echo "include $f;"; done > "$B/vhosts.inc"
echo "include $PWD/nginx.production.conf;" >> "$B/vhosts.inc"
sed "s#include /etc/nginx/vhosts/\*/\*.conf;#include $B/vhosts.inc;#" /etc/nginx/nginx.conf > /etc/nginx/wk196-nginx-test.conf
nginx -t -c /etc/nginx/wk196-nginx-test.conf; rm -f /etc/nginx/wk196-nginx-test.conf
# 4b. save through the panel (it drops the final newline, nothing else)
/usr/local/mgr5/sbin/mgrctl -m ispmgr webdomain.plain elid=prereborn.ru nginx_data="$(cat nginx.production.conf)" sok=ok
diff <(cat /etc/nginx/vhosts/www-root/prereborn.ru.conf; echo) nginx.production.conf
nginx -t && systemctl reload nginx     # graceful: old workers finish their requests, no downtime
```

**5. PostgreSQL**

```bash
sudo -u postgres psql -c "ALTER SYSTEM SET log_error_verbosity = 'terse'" -c "SELECT pg_reload_conf()"
```

**6. Check the site and integrations**

```bash
curl -sI https://prereborn.ru | head -1
curl -s https://prereborn.ru/api/health
curl -sI https://prereborn.ru/overlay/00000000-0000-4000-8000-0000000fake0 | grep -i referrer-policy   # strict-origin
curl -s -o /dev/null -w '%{http_code}\n' https://prereborn.ru/api/stream/overlay/00000000-0000-4000-8000-0000000fake0   # 404, a fake token
```

Then by hand: sign in on the site, open `/account`, and connect or
reconnect Steam and Twitch from Companion. A legacy OBS source with a real
URL should keep updating, and the local Companion overlay is unaffected.

**7. Check the new log lines**: test markers only, never real tokens.

```bash
curl -s -o /dev/null 'https://prereborn.ru/api/stream/integrations/twitch/callback?state=wk196fake&code=wk196fake'
curl -s -o /dev/null -H 'Referer: https://prereborn.ru/overlay/wk196fake?debug=1' https://prereborn.ru/api/health
grep -c wk196fake /var/www/httpd-logs/prereborn.ru.access.log /var/www/httpd-logs/prereborn.ru.error.log   # 0 and 0
tail -n 3 /var/www/httpd-logs/prereborn.ru.access.log     # [token], ?[redacted], "https://prereborn.ru"
sudo -u postgres psql -Atc "SHOW log_error_verbosity"     # terse
# after the second nightly logrotate run (see below):
ls -l --time-style=long-iso /var/www/www-root/data/www/prereborn.ru/shared/logs   # *.log.1 present, nothing older than 14 days
grep -E 'prereborn|postgresql' /var/lib/logrotate/status
```

logrotate rotates a file only once it has a state entry. The first nightly
run after step 3 merely records the four new PM2 files (`log does not need
rotating`), so `lastaction` (the cleanup of older files) doesn't run until
the **second** night. PostgreSQL already has a state entry and rotates on
the first night.

**8. Rollback**: each step is independent.

| Step | Rollback |
|---|---|
| 2 nginx format | `rm /etc/nginx/conf.d/prereborn-logging.conf` only **after** the vhost no longer references it, then `nginx -t && systemctl reload nginx` |
| 2 logrotate | `rm /etc/logrotate.d/prereborn-pm2`; `cp -a "$B/postgresql-common" /etc/logrotate.d/` |
| 3 app | revert the PR on `main` (normal deploy), or `release.sh` with the previous release. A release without `merge_logs` goes back to `*-<pm_id>.log` files, which can reuse an old, never-written file, so also `rm /etc/logrotate.d/prereborn-pm2`: its cleanup would otherwise be able to delete a file PM2 has open |
| 4 vhost | `mgrctl -m ispmgr webdomain.plain elid=prereborn.ru nginx_data="$(cat "$B/prereborn.ru.conf.orig")" sok=ok`, then `nginx -t && systemctl reload nginx` |
| 5 PostgreSQL | `ALTER SYSTEM RESET log_error_verbosity; SELECT pg_reload_conf();` |

### Production state

Applied on 2026-10-22, release `fc5287c` (PR #158). Backups of the
previous configs are in `/root/wk196-backup-20261022/` (mode 700):
`prereborn.ru.conf.orig`, `postgresql-common.orig`, `nginx-T.orig.txt`,
`pg-settings.orig.txt`.

- PM2 runs as **root** (`/root/.pm2`) and also hosts other sites' apps. Only
  `prereborn-api` and `prereborn-web` use `shared/logs` (`root:root 755`),
  which is why the logrotate file uses `su root root`. logrotate runs as
  root and the directory isn't group/world-writable, so `su` isn't strictly
  required. It overrides the global `su root adm` and matches
  `postgresql-common`.
- nginx 1.26, PostgreSQL 16 (`logging_collector=off`, stderr →
  `/var/log/postgresql/`), logrotate 3.21 via `logrotate.timer` at 00:00 MSK.
- The ISPmanager includes inside the vhost have regex locations only for
  their own paths (phpMyAdmin, Roundcube), so no conflict with the overlay
  locations. `conf.d/*.conf` is included at http level before the vhosts.
- Checked in production with fake markers: access.log masks overlay
  tokens (also `/OVERLAY`, `//overlay`, `%6Fverlay`), callback query strings
  (Twitch, DonationAlerts, Steam, any parameter order) and Referer. The
  markers are absent from access/error, PM2 and PostgreSQL logs. Upstream
  failures (502/504) were checked in the lab only.
- No live legacy overlay traffic during the check, so a real OBS source was
  not observed after the switch.

### Logs written before masking

They may hold overlay tokens, OAuth `code`/`state` and Steam IDs. Don't open
them. To inventory them, use only names, sizes and dates:

```bash
ls -l --time-style=long-iso /var/www/httpd-logs/ /var/www/www-root/data/logs/ | grep prereborn
```

- **nginx archives** expire on their own within the ISPmanager rotation
  (~11 days after step 4). To remove them sooner, after step 7 passes and
  the next daily rotation has moved the current file into the archive,
  delete what was last written before the switch. Deletion is a separate
  owner decision:
  `find /var/www/www-root/data/logs -name 'prereborn.ru.*' ! -newermt '<step 4 time>' -delete`.
- **PM2 logs**: pre-WK-196 per-id files older than 14 days are removed by
  the logrotate `lastaction`, the rest age out within 14 days. They can only
  contain an overlay token on a 5xx line.
- **PostgreSQL logs** age out within 14 days of step 2.
- **OAuth**: nothing to revoke. Authorization codes are single-use and
  short-lived, and the server already exchanged them. `state` is consumed
  on first use. Steam OpenID assertions are nonce-bound. Twitch and
  DonationAlerts access/refresh tokens are exchanged server-to-server and
  never appear in a URL.
- **Overlay tokens**: a token gives read-only access to the stream's overlay
  data (and creates an active session if none exists). The logs can be read
  only by root and the www-root/deploy account, and there are no backups.
  Reissuing would break every legacy `prereborn.ru/overlay/<token>` OBS
  source, and the site no longer shows a URL to replace it with, so in
  practice it forces the move to the Companion overlay. That belongs to
  WK-198, not here. Reissue everyone's tokens immediately only if there are
  signs that the logs reached a third party.
