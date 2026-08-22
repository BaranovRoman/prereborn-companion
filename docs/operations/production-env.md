# Production environment

Where production config/secrets live, how they reach the running API/web
processes, and what to do when a new environment variable is needed. Pairs
with [docs/production-deployment.md](../production-deployment.md) (server
bootstrap, GitHub environment/secrets list).

## Where it lives

Production secrets are **not** stored in the git checkout and are never
committed. They live as [GitHub Actions environment secrets](https://github.com/BaranovRoman/prereborn-companion/settings/environments)
under the `production` environment.

On every deploy (`.github/workflows/deploy-production.yml`, triggered after
`CI` succeeds on `main`), the "Install production environment" step:

1. Reads the secrets into step-scoped env vars (GitHub automatically masks
   their values in logs).
2. Assembles them, plus a small set of stable public values (URLs, ports),
   into a full `.env` file content.
3. Writes it directly over SSH with `umask 077` (`cat > shared/.env`, mode
   `600`), **replacing the file on the server completely** — it never
   appends or merges with whatever was there before.
4. Runs `release.sh` on the server, which sources `shared/.env`, applies
   migrations against the already-built release, atomically switches
   `current`, and reloads both PM2 processes with `--update-env` so they
   pick up the fresh values.

**WK-80 build-time note:** `NEXT_PUBLIC_*` values are inlined into the web
build *before* this step even runs - the "Build release artifact" step
earlier in the same workflow sets them directly as its own (non-secret)
step env, not from `shared/.env`. See
[docs/research/wk-80-build-outside-production.md](../research/wk-80-build-outside-production.md)
for the full build-time/runtime split.

**The list of variables written in step 2 is the single source of truth for
what reaches production.** `.env.example` / `env.production.example` in the
repo are documentation only — they are never read by the deploy workflow or
copied to the server.

This is why `ADMIN_EMAILS` disappeared after a deploy: it was documented in
`.env.example` and read by the API, but missing from the fixed list in
`deploy-production.yml`, so every deploy overwrote the server's `.env`
without it.

## Adding a new production env variable

There is no automatic sync from code to production — a new variable needs to
be wired in explicitly, or it will silently stay unset (or get wiped) on the
next deploy:

1. Add it to `.env.example` (and `env.production.example` if it differs
   between local and production) with a placeholder/empty value — never a
   real secret.
2. Classify it:
   - **required**: the app cannot start or a core feature is fundamentally
     broken without it (e.g. `DATABASE_URL`, `STREAM_JWT_SECRET`). Add a
     fail-fast check in `apps/api/src/config/env.ts` (see the existing
     `STREAM_JWT_SECRET`/`DATABASE_URL` checks) so a missing value throws a
     clear startup error instead of failing silently later.
   - **optional**: a feature degrades gracefully when absent (e.g.
     `ADMIN_EMAILS` empty ⇒ no admin access, `TWITCH_CLIENT_ID` empty ⇒
     Twitch integration reports unconfigured). Give it a safe default/`null`
     fallback in code, same as the existing optional vars in `env.ts`.
   - **secret**: credentials, connection strings, tokens, or anything else
     that shouldn't be visible outside the production environment.
3. Add it to `.github/workflows/deploy-production.yml`:
   - Secret values → add a `secrets.NAME` entry to the step's `env:` block,
     then a `printf 'NAME=%s\n' "$NAME"` line in the `.env` assembly. Only
     add a `test -n "$NAME"` guard if the variable is genuinely required —
     do not gate the deploy on an optional variable.
   - Stable public values (URLs, ports) can be hardcoded directly in the
     `printf` list, same as `NODE_ENV` or `NEXT_PUBLIC_SITE_URL` today.
   - If it's a secret, add it once to the GitHub `production` environment
     (UI: repo Settings → Environments → production → Secrets, or
     `gh secret set NAME --env production`).
4. Do not assume a developer (or agent) will manually SSH in and add it to
   the server afterwards — if it isn't in the workflow's list, it will not
   reach production, full stop.

See also the short rule in [AGENTS.MD](../../AGENTS.MD).

## How secrets reach runtime

GitHub `production` environment secret → workflow step env var (masked in
logs by GitHub) → piped into an SSH `cat > shared/.env` heredoc (never
written to the Actions runner's disk, never echoed) → sourced by
`release.sh` on the server → used for migrations and exported to PM2 via
`ecosystem.config.cjs` + `pm2 reload/restart --update-env`. Secrets never
reach the build step - `NEXT_PUBLIC_*` inlining happens earlier, on the
GitHub runner, from non-secret step env only (see WK-80).

## Current variable inventory

**Required** (missing value throws a clear startup error):

- `DATABASE_URL` — Postgres connection string. Secret.
- `STREAM_JWT_SECRET` — signs stream-user auth tokens. Secret.

**Optional, safe default/fallback** (missing value degrades a feature, never
breaks the app):

- `ADMIN_EMAILS` — comma-separated admin allowlist; empty ⇒ admin panel is
  unreachable to everyone. Sensitive (treat as secret; contains a real
  email), not required.
- `PORT`, `NODE_ENV`, `LOG_LEVEL` — defaults are production-safe.
- `CORS_ALLOWED_ORIGINS` — empty in production logs a startup warning and
  rejects all browser origins, but does not crash the process.
- `STEAM_OPENID_REALM`, `STEAM_OPENID_RETURN_URL`, `OPENDOTA_API_KEY` — Steam
  binding/OpenDota integration degrade to "not configured" when absent.
- `TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET`, `TWITCH_REDIRECT_URI`,
  `TWITCH_FRONTEND_ORIGIN` — Twitch integration degrades when absent at the
  API level. Secret (client ID/secret). The deploy workflow currently treats
  the client ID/secret as required for this project's production deploy
  (fails the deploy, not the API) — that's a deploy-time choice, not an
  API-level requirement.
- `DONATION_ALERTS_CLIENT_ID`, `DONATION_ALERTS_CLIENT_SECRET`,
  `DONATION_ALERTS_REDIRECT_URI`, `DONATION_ALERTS_FRONTEND_ORIGIN` — same
  pattern as Twitch. Secret (client ID/secret).
- `*_RATE_LIMIT_WINDOW_MS` / `*_RATE_LIMIT_MAX` (login, stream auth, steam
  callback, upload, contact, solitaire, stream companion) — all have
  production-safe defaults in `env.ts`.
- `MAX_VIDEO_UPLOAD_SIZE_MB` — defaults to 500; if changed, update
  `client_max_body_size` in `nginx.production.conf` too (not read from env).
- `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_SITE_URL` — web build/runtime, not
  secret (public URLs), but should be set for correct absolute links.
- `NEXT_PUBLIC_MEDIA_BASE_URL`, `NEXT_PUBLIC_DOTA_COMPANION_DOWNLOAD_URL` —
  have safe fallbacks in `apps/web/src/shared/config/*`.
- `BACKEND_URL` — set directly in `ecosystem.config.cjs` for the web PM2
  process, not sourced from `.env`.
- `UPLOADS_DIR` — WK-80: absolute path to user-uploaded files, deliberately
  outside the versioned `releases/<sha>/` tree (`shared/apps-api-uploads`).
  Falls back to `process.cwd()`-relative `uploads/` when unset (local dev
  only) - never falls back like that in production, since `process.cwd()`
  under a release directory would silently scope uploads to one release and
  orphan them on the next deploy switch. See
  `apps/api/src/config/env.ts` and
  `docs/research/wk-80-build-outside-production.md`.

## One-time migration: `ADMIN_EMAILS`

The production server's `.env` may currently be missing `ADMIN_EMAILS`
entirely (that's the bug this change fixes). There is nothing to migrate out
of the old file — nothing automatically transfers a value that was never
durably stored anywhere but a developer's memory/SSH session. To finish
setup once:

```bash
gh secret set ADMIN_EMAILS --env production
# paste the real comma-separated admin email(s) when prompted, e.g.:
# admin@example.com
```

(Use the email(s) that sign in via the existing Steam/Twitch stream-user
login — the admin check matches against that account's email, see
`apps/api/src/middleware/require-admin.ts`.)

The next deploy after the secret is set will include it automatically — no
further manual step.

## Verifying without exposing secret values

- `gh secret list --env production` — lists secret **names** and last-updated
  timestamps only, never values.
- `curl -s https://prereborn.ru/api/health` — reports boolean
  `integrations.*Configured` flags (`twitchConfigured`,
  `donationAlertsConfigured`, `adminAccessConfigured`) so you can confirm a
  variable took effect after a deploy without ever seeing its value.
- Never `cat`/log the assembled `.env` on the server or in CI output.
