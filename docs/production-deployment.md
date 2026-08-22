# Production deployment

Production deploys automatically after the `CI` workflow succeeds for `main`.
GitHub Actions builds a versioned, self-contained release artifact on the
runner itself (see `scripts/build-release-artifact.sh`) - the production
server never runs `pnpm install`, `next build`, or `tsc`. The artifact is
uploaded over SSH, then `release.sh` on the server extracts it into
`releases/<sha>/`, applies database migrations against its compiled output,
atomically switches the `current` symlink, reloads PM2, and runs health
checks - automatically rolling `current` back to the previous release if the
new one doesn't come up healthy. See
`docs/research/wk-80-build-outside-production.md` for the full design and
`scripts/test-release-sh.sh` for a local dry run of the whole flow (extract,
migrate, atomic switch, health check, automatic rollback) against a
throwaway Postgres database and real PM2, no production server involved.

## Production layout

```
/var/www/www-root/data/www/prereborn.ru/
├── releases/<sha>/        # one directory per deployed commit - web/api build output + node_modules
├── current -> releases/<sha>   # atomically repointed on every successful deploy
├── shared/
│   ├── .env                    # written by "Install production environment" - never per-release
│   └── logs/                   # PM2 error/out logs
├── apps/api/uploads/       # user-uploaded files (UPLOADS_DIR) - unchanged path, see below
└── incoming/               # scratch space for the just-uploaded artifact + release.sh
```

`nginx.production.conf` is untouched by this layout: every route proxies to
the PM2-managed Node processes on fixed loopback ports (5100/5102), so
nginx never needs to know which release is current - only
`ecosystem.config.cjs` (via the `current` symlink) and `release.sh` do.
`apps/api/src/config/env.ts`'s `UPLOADS_DIR` deliberately keeps uploaded
files out of the versioned `releases/<sha>/` tree entirely - `process.cwd()`
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
