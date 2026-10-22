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
removed automatically; secrets and one-time OAuth parameters never reach the
access log.

| Log | Where | Retention | Config |
|---|---|---|---|
| nginx access/error | `/var/www/httpd-logs/prereborn.ru.*.log`, archives in `/var/www/www-root/data/logs/` | daily, `rotate 10` (~11 days) | ISPmanager (`/etc/logrotate.d/web/prereborn.ru`, generated) |
| PM2 (API + web) | `shared/logs/{api,web}-{out,error}.log` | daily, 14 days | `deploy/logrotate/prereborn-pm2` → `/etc/logrotate.d/prereborn-pm2` |
| PostgreSQL | `/var/log/postgresql/*.log` | daily, 14 days | `deploy/logrotate/postgresql-common` → `/etc/logrotate.d/postgresql-common` |

What is masked in the access log (`log_format prereborn_masked`,
`deploy/nginx/prereborn-logging.conf`):

- `/overlay/<token>` and `/api/stream/overlay/<token>` → `/overlay/[token]`
  (query string dropped), also in `Referer` - the overlay page's own requests
  send it as Referer;
- `/api/stream/integrations/*/callback?...` → `...callback?[redacted]` (OAuth
  `code`/`state`, Steam `openid.*`).

The API request logger masks the overlay token the same way
(`apps/api/src/middleware/request-logger.ts`; query strings are never logged
there). The nginx **error** log has no configurable format: an upstream error
on an overlay request still writes the full request line. It is covered only
by the ~11-day rotation, not by masking.

The nginx retention is already within 14 days and is left to ISPmanager on
purpose: the file is regenerated by the panel, so a manual edit would not
survive. If the site's log settings in ISPmanager are ever changed, keep
rotation at ≤ 14 days.

### One-time server setup (root)

Order matters: the `prereborn_masked` format must exist before the vhost
references it, otherwise `nginx -t` fails.

```bash
# 1. nginx: http-level masked log format
install -m 0644 deploy/nginx/prereborn-logging.conf /etc/nginx/conf.d/prereborn-logging.conf
nginx -t
# 2. ISPmanager → Sites → prereborn.ru → nginx config: paste nginx.production.conf
#    (only change: `access_log ... prereborn_masked;`), save, then
nginx -t && systemctl reload nginx

# 3. PM2 logs (merge_logs ships with the next deploy via ecosystem.config.cjs)
install -m 0644 deploy/logrotate/prereborn-pm2 /etc/logrotate.d/prereborn-pm2
find /var/www/www-root/data/www/prereborn.ru/shared/logs -type f -mtime +14 -delete
logrotate -d /etc/logrotate.d/prereborn-pm2   # dry run, check for errors

# 4. PostgreSQL log
cp /etc/logrotate.d/postgresql-common /root/postgresql-common.logrotate.bak
install -m 0644 deploy/logrotate/postgresql-common /etc/logrotate.d/postgresql-common
logrotate -d /etc/logrotate.d/postgresql-common
find /var/log/postgresql -type f -name '*.log.*' -mtime +14 -delete
# stop writing failed statements' text and DETAIL (may contain field values)
sudo -u postgres psql -c "ALTER SYSTEM SET log_min_error_statement = 'panic'" \
  -c "ALTER SYSTEM SET log_error_verbosity = 'terse'" -c "SELECT pg_reload_conf()"
```

Archives of the access log written before masking still contain tokens; they
expire within the ISPmanager rotation (~11 days) or can be deleted by hand.
Whether to reissue streamers' overlay tokens is the owner's decision.

### Verification

```bash
curl -s -o /dev/null https://prereborn.ru/api/stream/overlay/wk196-check
curl -s -o /dev/null 'https://prereborn.ru/api/stream/integrations/twitch/callback?code=wk196&state=wk196'
grep -c wk196 /var/www/httpd-logs/prereborn.ru.access.log   # must be 0
tail -n 5 /var/www/httpd-logs/prereborn.ru.access.log        # [token] / ?[redacted]
ls -la --time-style=long-iso /var/www/www-root/data/www/prereborn.ru/shared/logs  # nothing older than 14 days; next day: *.log.1
grep -E 'rotate|maxage|daily|weekly' /etc/logrotate.d/web/prereborn.ru /etc/logrotate.d/prereborn-pm2 /etc/logrotate.d/postgresql-common
sudo -u postgres psql -Atc "SHOW log_min_error_statement" -c "SHOW log_error_verbosity"
```
