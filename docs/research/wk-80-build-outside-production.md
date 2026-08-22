# WK-80: Build outside production — research & design

## Scope

Research/design only. No workflow, script, production config, or application code
changed in this phase. This document covers two related but architecturally
separate pipelines, both in scope for WK-80 per the ticket's current text:

- **Part A** — the web/API production deploy pipeline (`.github/workflows/deploy-
  production.yml`, `deploy.sh`, the single production VDS). Goal: production stops
  building and only deploys a pre-built, versioned artifact.
- **Part B** ("Piper removal") — the Companion desktop **release** pipeline
  (`.github/workflows/windows-release.yml`, GitHub Releases). Goal: drop Piper
  entirely from the TTS fallback chain and from the release build.

These share no infrastructure: Part A runs against `prereborn.ru`'s VDS over SSH;
Part B runs on a `windows-latest` GitHub-hosted runner and publishes a GitHub
Release consumed by the desktop app's own downloader. They're addressed together
here only because both remove a heavy build step from a "production-facing"
pipeline. Findings below are kept in two clearly separated parts for that reason.

---

# Part A — Web/API production deploy

## 1. CURRENT PIPELINE

`.github/workflows/deploy-production.yml` triggers on `workflow_run` after `CI`
(`.github/workflows/ci.yml`) succeeds on `main`. Steps, in order:

1. Checkout the exact verified commit (`github.event.workflow_run.head_sha`).
2. SSH: `mkdir -p` the deploy directory (idempotent, handles first-ever deploy).
3. `rsync -az --delete` the full source tree to
   `/var/www/www-root/data/www/prereborn.ru`, excluding `.git/`, `.env`,
   `node_modules/`, `logs/`, `apps/api/uploads/`, `apps/web/public/vendor/valve/video/`.
4. SSH: write a fresh `.env` (mode 600) assembled from GitHub Actions secrets +
   hardcoded public values, **replacing** the previous file entirely.
5. SSH: run `deploy.sh` on the server with `SKIP_GIT_PULL=1`.
6. From the Actions runner: `curl` `/api/health` as a final check.

`deploy.sh` (server-side), guarded by the WK-78 `flock` on
`/tmp/prereborn-production-deploy.lock`:

1. Refuse to start if ports 5100/5102 are occupied by anything other than the
   existing `pm2` processes.
2. Require `.env`, `source` it (`set -a`).
3. `corepack pnpm install --frozen-lockfile` — **no `--prod`**, so this installs
   every `devDependency` of every workspace package (TypeScript, ESLint, Vitest,
   `@playwright/test`, Sass, etc.), not just runtime deps.
4. `corepack pnpm --filter @prereborn/web build` — full `next build`.
5. `corepack pnpm --filter @prereborn/api build` — `tsc` compiles `src/` → `dist/`.
6. `corepack pnpm --filter @prereborn/api db:migrate` — this script is
   `"pnpm build && node dist/db/migrate-cli.js"` (`apps/api/package.json:12`), so
   **the API is compiled a second time** in the same deploy, then migrations run.
7. `pm2 startOrReload ecosystem.config.cjs --update-env`, then
   `pm2 restart prereborn-api --update-env` (needed because `startOrReload` can
   preserve a live fork's stale env), then `pm2 save`.
8. Local health checks against `127.0.0.1:5102/api/health` and `:5100`, including
   asserting `twitchConfigured`/`donationAlertsConfigured` are `true` (an
   env-wiring smoke test, not just "process is up").

**Measured, not assumed** (from `gh run view` on run `32589954814` /
`32589803601`, 2026-08-22):

| Stage | Where | Measured duration |
|---|---|---|
| CI: `pnpm build` (web+api, verification only, nothing shipped from here) | GitHub-hosted runner | 27s |
| CI: full run (typecheck, lint, build, unit tests, Playwright e2e) | GitHub-hosted runner | 2m47s |
| Deploy: "Build, migrate and reload" (full `deploy.sh`: `pnpm install` **without `--prod`** + web build + API build + API rebuild via `db:migrate` + migrate + `pm2` reload + health checks) | **production VDS** | 1m25s |
| Deploy: whole job (SSH setup, rsync, `.env` write, build+migrate+reload, health verify) | mixed | 1m35s |

This was a fast, uncontended run. The WK-78 incident (`docs/research/wk-78-
companion-reliability-and-deploy-concurrency.md`) shows the same "Build, migrate
and reload" step taking 10+ minutes and eventually wedging `sshd` when a cancelled
retry landed on top of a still-running build — the 1m25s above is the happy path,
not a guaranteed bound.

## 2. CURRENT RISKS

Risks still open after WK-78 (which fixed the *concurrency* gap, not the
*resource-contention* one it was named after):

1. **Every deploy installs the entire devDependency tree on production**, not
   just runtime deps — `deploy.sh` runs bare `pnpm install`, never `--prod` (see
   §1 step 3). TypeScript, ESLint, Vitest, `@playwright/test`, Sass compilers, etc.
   are installed and left on disk, on a VDS also running the live PM2 processes.
2. **Two full builds compete with the live service for the same CPU/RAM** on a
   single small VDS with no second instance to fall back to: `next build` and
   `tsc` (twice, see §1 step 6) run while `prereborn-web`/`prereborn-api` are
   still serving production traffic. This is the direct, mechanistic explanation
   WK-78 could only infer indirectly (sshd becoming unresponsive during a
   resource-starved build).
3. **The `flock` (WK-78) prevents two builds from overlapping — it does not
   prevent one build from starving the running service.** It closes the race,
   not the contention.
4. **No image-optimization dependency verification.** `apps/web` uses
   `next/image` in 6 files (`grep -rl next/image apps/web/src` → landing,
   stream/settings, stream/register, stream/queue (×2), stream/login), no
   `images.unoptimized` flag is set anywhere, and Next 16's self-hosted image
   optimizer requires `sharp` at runtime (no JS fallback since Next 13). `sharp`
   is a dependency of `@prereborn/api` only (`apps/api/package.json`) — pnpm's
   strict, non-hoisting install means it is **not resolvable from
   `apps/web`** (confirmed: no `sharp` under `apps/web/node_modules` or the
   workspace root `node_modules`). This is a pre-existing condition, not
   something this migration introduces, but it directly affects what the new
   web artifact must contain (§4) and is flagged as an open question (§12) —
   verify whether `/_next/image` requests are actually erroring in production
   today before deciding.

## 3. TARGET ARCHITECTURE

**Recommendation: build inside the existing deploy job, on the GitHub-hosted
runner, then ship build output (not source) to the server.** Do *not* introduce
a second workflow or cross-workflow artifact hand-off.

Reasoning:

- The monorepo has no shared workspace packages (`pnpm-workspace.yaml` only lists
  `apps/*`; `grep -r "workspace:"` across `apps/*/package.json` finds nothing) —
  `apps/web` and `apps/api` build fully independently. Nothing needs a
  cross-package build step.
- `runs-on: ubuntu-latest` already matches a standard Linux VDS target
  architecture (x86_64), and CI already proves the build succeeds on that exact
  runner image before deploy triggers — reusing it needs no new toolchain, no
  cross-compilation, no Docker.
- A second workflow (CI uploads a `next build`/`tsc` artifact via
  `actions/upload-artifact`, deploy downloads it via
  `actions/download-artifact` keyed on `workflow_run.id`) is more "correct"
  (build once) but adds real moving parts: artifact-expiry as a new deploy
  failure mode, an extra permission (`actions: read`), and a second thing to
  keep in sync if the workflows ever diverge. At this project's scale (single
  small VDS, ~30s-1min builds on a GitHub runner) the wasted compute from
  building twice (once in CI to gate the merge, once in deploy to produce the
  shippable artifact) is negligible and buys a strictly simpler pipeline.
- Building inside the deploy job also means it can build with the exact
  `head_sha` it's about to deploy, no artifact-passing/identity bookkeeping
  needed.

Target flow: **CI (gate) → deploy workflow builds on GitHub runner → versioned
artifact → transfer to server → unpack into `releases/<sha>/` → migrate → atomic
release-pointer switch → PM2 reload → health check → (auto-rollback on
failure).**

### The nginx layer already avoids the hardest part of "atomic switch"

`nginx.production.conf` does **not** serve the app's files from disk. Every
route proxies to the Node processes on fixed loopback ports:

```
location /api          → proxy_pass http://127.0.0.1:5102   (API)
location /_next/static/ → proxy_pass http://127.0.0.1:5100   (web)
location /              → proxy_pass http://127.0.0.1:5100   (web, catch-all — incl. /_next/image)
location /uploads/      → alias .../apps/api/uploads/         (persistent user data)
location /media/        → alias /var/www/.../data/media/prereborn/  (WK-67, already outside the deploy tree)
```

So "switching the release" only has to mean **"which directory do the PM2
processes run from,"** not "which directory does nginx serve static files
from." This matters because of one nginx directive that would otherwise be a
real blocker: `disable_symlinks if_not_owner from=$root_path;` (line 20, an
ISPmanager vhost template default) makes nginx refuse to follow a symlink
under `$root_path` it doesn't consider correctly owned. `/uploads/` is served
via `alias` **under** `$root_path` today, as a fixed absolute path (not
through any symlink). If the classic `current -> releases/<sha>` pattern were
applied naively by turning `$root_path` itself into that symlink, `/uploads/`
would (a) start resolving through a symlink nginx might refuse per that
directive, verification needed (see §12), and (b) start pointing at
*versioned, per-release* storage for what must be *persistent* user-uploaded
files.

**Recommendation: keep nginx's `root_path` exactly as-is (a plain, non-symlinked,
fixed directory) and never let nginx see the versioned `releases/` tree at
all.** Only PM2 needs to know which release is current. Concretely:

```
/var/www/www-root/data/www/prereborn.ru/        # unchanged nginx root_path, stays fixed
├── releases/
│   ├── <sha-1>/                                 # full artifact contents (§4)
│   ├── <sha-2>/
│   └── ...
├── current -> releases/<sha-2>                  # symlink, read only by deploy.sh + ecosystem.config.cjs
├── shared/
│   ├── .env                                     # written here, not per-release
│   ├── logs/                                    # pm2 error/out logs
│   └── apps-api-uploads/                        # bind target for apps/api/uploads
├── apps/api/uploads/ -> ../shared/apps-api-uploads/   # single stable symlink, created once, never re-created per deploy
```

The one remaining symlink nginx's `/uploads/` alias touches
(`apps/api/uploads/`) is deliberately created **once**, outside any per-deploy
churn, and pointed at storage that's never part of a release — so the ISPmanager
`disable_symlinks` risk is scoped to a single, one-time, verifiable setup step
instead of every deploy. This still needs to be checked against real file
ownership on the server before relying on it (§12) — that verification could
not be done from this environment (no server shell access here, same
constraint WK-78 hit for its `flock` verification).

`ecosystem.config.cjs`'s `root` constant changes from the fixed deploy path to
the `current` symlink path; PM2 itself follows that symlink at process-spawn
time (`cwd`), which is unaffected by nginx's directive (that's an nginx-only
restriction on directly-served static files, not a Node process's own
filesystem access).

### Why not decouple the trigger from CI further

Keeping `workflow_run` on `CI` success (unchanged) is fine — the artifact build
step simply becomes a new phase inside the existing deploy job, using the exact
commit CI already verified.

## 4. ARTIFACT CONTENTS

The monorepo currently has **no `output: "standalone"`** in
`apps/web/next.config.js` (confirmed — the file has no `output` key at all).
Without it, `next start` needs the *entire* `apps/web/node_modules` tree at
runtime (React, Next, antd, `@ant-design/icons`, `motion`, `axios`, plus every
transitive dependency) — hundreds of MB, most of it devDependencies-adjacent
tooling never touched at runtime.

**Recommendation: enable `output: "standalone"` for `apps/web`.** Next traces
the actual runtime `import` graph and emits a self-contained
`.next/standalone/` (server + only the `node_modules` it really needs) plus
`.next/static/` (client assets) and `public/` copied in separately. This is
the officially-supported way to get a minimal, non-monorepo-aware runtime
bundle, and it doesn't fight pnpm's strict linking model.

One caveat this migration must decide, not silently inherit: **`output:
"standalone"`'s tracer only bundles a dependency if it's actually resolvable
from `apps/web`.** Since `sharp` currently isn't (§2, risk 4), standalone
tracing won't add it either — the artifact would ship with exactly the same
image-optimization gap that may or may not already exist in production today.
This needs an explicit decision during implementation: add `sharp` as a real
`apps/web` dependency (so tracing includes its native binary and the artifact
gets correctly image-optimizing), or set `images.unoptimized: true` if
optimization isn't actually wanted. Not resolved here — flagged in §12.

For `apps/api` (plain `tsc`, no bundler, ESM `"type": "module"`), the
equivalent building block is **`pnpm deploy`** — pnpm's built-in command for
producing a self-contained, non-symlinked, prod-only `node_modules` for one
workspace package into a target directory (`pnpm deploy --filter @prereborn/api
--prod out/api`), designed for exactly this "ship one workspace package
without the rest of the monorepo" case. Combine with the already-built
`dist/`.

**Artifact layout (per release):**

```
release.tar.zst  (or .tar.gz)
├── VERSION                    # commit SHA + build timestamp (plain text)
├── web/
│   ├── standalone/            # next build output: --output standalone
│   │   ├── server.js
│   │   ├── node_modules/      # traced, minimal
│   │   └── apps/web/...       # Next's standalone layout nests the app dir
│   ├── static/                # .next/static — served today via /_next/static/ proxy
│   └── public/                # apps/web/public (incl. vendor/valve/* minus excluded video)
├── api/
│   ├── dist/                  # tsc output
│   └── node_modules/          # pnpm deploy --prod output (incl. sharp's native binary)
├── ecosystem.config.cjs       # or a template; see §11
```

Explicitly **not** in the artifact: `.env`, any secret, `.git/`, source `.ts`
files, devDependencies, `apps/api/uploads/` (persistent, lives in `shared/`),
`apps/web/public/vendor/valve/video/` (already excluded from rsync today for
size, same reasoning applies), the `/media/` tree (already independently
deployed per WK-67, untouched by this).

## 5. ENV MATRIX

Checked what `apps/web`/`apps/api` actually read from `process.env`, not
assumed. `apps/api` has **zero** build-time env dependency — `tsc` is a pure
type-erasure compile, nothing in `apps/api/src` reads `process.env` at module
load in a way that affects compiled output. All API env is runtime-only,
read by `apps/api/src/config/env.ts` when the process starts.

`apps/web`'s `next build` **does** need env at build time — any `NEXT_PUBLIC_*`
value gets inlined into the client JS bundle. The full accounting of
`NEXT_PUBLIC_*` values currently written by `deploy-production.yml`
(`.github/workflows/deploy-production.yml:123-126`):

| Variable | Build-time (inlined) | Secret? |
|---|---|---|
| `NEXT_PUBLIC_API_URL` | yes | no (`/api`, relative) |
| `NEXT_PUBLIC_SITE_URL` | yes | no (public URL) |
| `NEXT_PUBLIC_MEDIA_BASE_URL` | yes | no (public URL) |
| `NEXT_PUBLIC_DOTA_COMPANION_DOWNLOAD_URL` | yes | no (public GitHub Releases URL) |

None of the four are secret. **This means the CI build job needs zero GitHub
secrets to produce the artifact** — a real, verified security property, not an
assumption: building the artifact and assembling `.env` with actual secrets
stay fully decoupled, exactly as decoupled as they are today. The "Install
production environment" step in `deploy-production.yml` (writing `.env` over
SSH from masked secrets, never touching the runner's disk) needs **no
change** in shape — it still runs against the server, still only there.

Runtime-only (read from `.env` at process start, per
`docs/operations/production-env.md`'s existing classification — reproduced
here for completeness, not re-derived):

**Required (secret):** `DATABASE_URL`, `STREAM_JWT_SECRET`.
**Optional/secret-ish:** `ADMIN_EMAILS`, `TWITCH_CLIENT_ID`/`_SECRET`,
`DONATION_ALERTS_CLIENT_ID`/`_SECRET`, `OPENDOTA_API_KEY`.
**Optional/non-secret:** `PORT`, `NODE_ENV`, `CORS_ALLOWED_ORIGINS`,
`STEAM_OPENID_REALM`/`_RETURN_URL`, `TWITCH_REDIRECT_URI`/`_FRONTEND_ORIGIN`,
`DONATION_ALERTS_REDIRECT_URI`/`_FRONTEND_ORIGIN`, rate-limit tuning vars.
`BACKEND_URL` is set directly in `ecosystem.config.cjs`, never from `.env`.

None of these need to reach the artifact build step. `.env` continues to be
assembled and written only on the server, only from secrets, exactly as today.

## 6. RELEASE FLOW

1. CI succeeds on `main` → `deploy-production.yml` triggers (unchanged trigger).
2. Checkout `head_sha` (unchanged).
3. **New:** `pnpm install --frozen-lockfile` (full workspace, needed to build)
   on the GitHub runner, then `pnpm --filter @prereborn/web build` (with
   `output: standalone`), `pnpm --filter @prereborn/api build`, then
   `pnpm deploy --filter @prereborn/api --prod` into a staging dir.
4. **New:** assemble the artifact layout (§4), write `VERSION` (= `head_sha`),
   compress, checksum.
5. **New:** `scp`/`rsync` the single compressed artifact to the server into
   `releases/<sha>/` (extract there), instead of rsyncing the whole source
   tree. `.env` write step is unchanged (still targets `shared/.env`).
6. Server-side script (the direct successor to today's `deploy.sh`, still
   `flock`-guarded — see §10 of the WK-78 doc and §9 below for why the lock
   stays): `mkdir -p releases/<sha>`, extract, verify `VERSION` matches `<sha>`,
   run `node api/dist/db/migrate-cli.js` against the **already-extracted**
   `dist/` (no `tsc` on the server — the migration script itself never needed
   TypeScript at runtime, only `pnpm build && ...` did because `db:migrate`'s
   npm script bundles both), then atomically repoint `current` (`ln -sfn
   releases/<sha> current.tmp && mv -T current.tmp current` — `mv` on the same
   filesystem is atomic; a bare `ln -sfn` is not always atomic against a
   concurrent reader depending on symlink implementation details, so use the
   temp-then-rename form).
7. `pm2 reload ecosystem.config.cjs --update-env` (`ecosystem.config.cjs`'s
   `cwd` now resolves through `current`).
8. Local health checks (unchanged logic: `/api/health` +
   `twitchConfigured`/`donationAlertsConfigured` + web root check).
9. Actions runner: `curl --fail .../api/health` (unchanged).
10. **New, optional but recommended given §7:** on health-check failure,
    automatically repoint `current` back to the previous release and reload,
    rather than leaving the site down on a single-instance VDS.

## 7. FAILURE + ROLLBACK MATRIX

| Failure point | Production state | Recovery |
|---|---|---|
| Artifact fails to build on the runner (step 3) | **Unaffected** — old release still running, `current` untouched | Fix and re-run; nothing was ever pushed |
| Upload to server fails/interrupted (step 5) | **Unaffected** — partial upload lands in a not-yet-`current` `releases/<sha>/`, never referenced | Delete the partial dir, retry deploy |
| Extraction fails (corrupt archive, disk full) | **Unaffected** — same as above | Retry; alert if disk full (see §9) |
| Migration fails (step 6) | **Unaffected app-wise** — `current` still points at the old release, which is compatible with the *old* schema; **DB may be left with a partially-applied migration** if it isn't itself transactional | Because migrations are additive-only (§8), a partial migration is very unlikely to break the still-running old release. Fix the migration, redeploy. Manual DB inspection only if the migration script itself isn't idempotent (today's is: `IF NOT EXISTS`/`ADD COLUMN IF NOT EXISTS` throughout) |
| `current` switch fails (rare — same-filesystem `mv`) | Old release still current | Retry; this step is the smallest, most atomic part of the flow by design |
| `pm2 reload` fails / new process won't start | **Site down** (single fork instance, no second instance to fall back to while reloading) | **Automatic rollback recommended**: revert `current` to the previous release, `pm2 reload` again |
| `/api/health` fails post-switch | **Site potentially degraded/down** | Same as above — automatic revert-and-reload, since there's no cluster to just stop rolling out to |
| Health check passes but a *behavioral* regression ships (e.g. `twitchConfigured` flips false because of an env-wiring bug) | **Site up but degraded** | Caught by the existing `grep -q '"twitchConfigured":true'` assertion in today's health check logic — carry that assertion into the new flow unchanged; treat it as a rollback trigger too, not just a deploy-time-only check |

The key structural improvement over today: everything through "extraction" is
inherently safe (old release keeps serving), because nothing about it touches
the directory PM2 actually runs from. Today, a failure *during* `next build`/
`tsc` on the server can leave `apps/web`/`apps/api`'s in-place `dist/`/`.next/`
half-written **in the same directory the running process was started from** —
this migration removes that specific failure class entirely, independent of
the rollback automation described above.

## 8. MIGRATION STRATEGY

Read `apps/api/src/db/migrate.ts` in full (501 lines) and grepped it for
destructive statements: **zero** `DROP TABLE`/`DROP COLUMN`/`TRUNCATE`
anywhere. The script is a single idempotent `createTables()` function, applied
every deploy, built entirely from `CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF
NOT EXISTS`, `CREATE INDEX/UNIQUE INDEX IF NOT EXISTS` (63 such guards
counted), plus a few backfill `UPDATE`s that only touch rows where the new
column is still `NULL`.

This means the project **already follows expand-only, backward-compatible
migration discipline in practice** — nothing new needs to be invented for
WK-80's rollback story. An old release's code, if rolled back to after a newer
migration already ran, simply doesn't reference the new columns/tables it
doesn't know about; nothing about the additive schema breaks it. The one
practice worth stating explicitly (not enforced anywhere today) for this to
keep holding: **never add a `NOT NULL` column without a `DEFAULT`, and never
narrow/rename an existing column in place** — both would be a "contract"
change that an old, rolled-back release's queries could break against. The
current migration file already follows this instinctively (e.g. the
`result_source`/`rating_source` additions all carry defaults or stay
nullable).

Practical change: migrations now run as `node api/dist/db/migrate-cli.js`
directly against the artifact's already-compiled `dist/` (step 6, §6), instead
of `pnpm --filter @prereborn/api db:migrate`'s current `pnpm build && ...`
(which silently recompiles from source on the server today — removed
entirely, since `tsc` never runs on production again).

## 9. STORAGE / RETENTION

**On the server (`releases/`):** keep the last **3–5** releases. Given no
`output: standalone` today inflates `apps/web/node_modules` to hundreds of MB,
but a traced `standalone` build plus a pruned API `node_modules` should be an
order of magnitude smaller (exact number needs an empirical measurement in the
next phase — not fabricated here, see §12). Even a conservative estimate
(low hundreds of MB per release) keeps 5 releases well within normal VDS disk
budgets. Cleanup step: after a successful switch, delete releases older than
the newest N, **never** the one `current` points at or the one just replaced
(keep at least one prior release at all times for instant rollback).

**On GitHub (artifact transit):** the artifact only needs to exist between
"built on the runner" and "extracted on the server" within the same job run —
it does not need to be a durable `actions/upload-artifact` at all if built and
shipped within one job (§3's recommendation). If a future need arises to
re-deploy an old commit without rebuilding, GitHub Releases (already used for
the Companion desktop app, §Part B) would be the natural place to publish a
tagged artifact — but nothing in the current requirements calls for that, so
it's explicitly **not** part of this design (matches "don't build an
enterprise platform").

## 10. EXPECTED RESOURCE EFFECT

Removed from the production VDS, every deploy:

- `pnpm install --frozen-lockfile` **without `--prod`** for the whole
  workspace (TypeScript, ESLint, Vitest, `@playwright/test`, Sass, etc.) — gone
  entirely; the server never runs `pnpm install` again.
- `next build` — gone (moves to the GitHub runner, ~27s there per the CI
  measurement in §1).
- `tsc` for `apps/api` — gone, and specifically the **duplicate** compile
  inside `db:migrate`'s own `pnpm build && ...` — gone too.
- Disk churn from a fresh `node_modules` install every deploy — gone; the
  server only ever holds `releases/<sha>/{web,api}/node_modules`, written once
  per release, never reinstalled in place.

What remains on the server, every deploy: extract a compressed artifact
(fast, I/O-bound, no compilation), run one Node process for migrations
(`node dist/db/migrate-cli.js`, already fast per the CI measurement — 4s for
`db:migrate` including its own `tsc` step in that same run), `mv` a symlink,
`pm2 reload`. None of these compete meaningfully for CPU with the live
processes — the whole point.

## 11. IMPLEMENTATION PLAN

Files to change in the implementation phase (after design review — not
touched in this research phase):

- `.github/workflows/deploy-production.yml` — replace "Upload verified
  source" (raw `rsync` of the whole tree) with a build phase (install, build
  web+api, `pnpm deploy` for API, assemble artifact) + a "ship artifact"
  step (`scp`/`rsync` the compressed archive only); replace "Build, migrate
  and reload"'s SSH command with a call to the new server-side release
  script; add a rollback step gated on health-check failure.
- `deploy.sh` — replaced by a new server-side script (e.g. `release.sh`) that
  extracts the artifact into `releases/<sha>/`, runs migrations against the
  artifact's `dist/`, does the atomic `current` switch, reloads PM2, runs
  health checks, and rolls back `current` on failure. Keeps the WK-78 `flock`
  around the whole critical section (§ below).
- `apps/web/next.config.js` — add `output: "standalone"`; resolve the `sharp`
  question from §4/§12 (add as a real dependency, or set
  `images.unoptimized`).
- `ecosystem.config.cjs` — `root` constant points at the `current` symlink
  path instead of the fixed deploy path; adjust `cwd`/`script` paths to match
  the artifact's internal layout (`web/standalone/...`, `api/dist/index.js`).
- New: a small retention/cleanup step (script or inline in the release
  script) that prunes `releases/` beyond the last N (§9).
- `docs/production-deployment.md` and `docs/operations/production-env.md` —
  update the deploy description (source-tree rsync + on-server build →
  artifact-based), no changes to the env-variable inventory itself (§5 shows
  it's unaffected).
- `nginx.production.conf` — likely **no change** given the design in §3 (nginx
  never sees `releases/`), but the one existing `/uploads/` `alias` and the
  one-time `apps/api/uploads -> shared/apps-api-uploads` symlink setup need
  manual, on-server verification against the `disable_symlinks` directive
  before this is trusted (§12) — this is a one-time manual/documented step,
  not a workflow change.

**WK-78's `flock` stays.** Its job narrows (it no longer needs to prevent two
`pnpm build`s from fighting over CPU — that never happens on the server again)
but it still needs to protect the new critical section (extract → migrate →
switch → reload) from two overlapping deploy runs corrupting the `current`
pointer or racing migrations against each other. Removing it here would
reopen exactly the race WK-78 closed, for no benefit.

Also see **Part B, §"Piper removal implementation checklist"** below — the
user has asked that WK-80's implementation phase (after this design review)
cover both efforts together.

## 12. OPEN QUESTIONS / BLOCKERS

Only things actually found to be uncertain, not a generic caveats list:

1. **`disable_symlinks if_not_owner from=$root_path` in
   `nginx.production.conf:20`** — an ISPmanager vhost-template default whose
   exact ownership-matching behavior against the proposed one-time
   `apps/api/uploads -> shared/apps-api-uploads` symlink cannot be verified
   without server shell access (same constraint WK-78 hit for its `flock`
   verification). Must be checked live before the release-switch design is
   trusted; the design in §3 was chosen specifically to minimize exposure to
   this directive (nginx never touches `releases/`), but the one remaining
   symlink still needs a real check.
2. **`sharp` / `next/image` optimization gap (§2 risk 4, §4).** Unclear
   whether this is already silently broken in production today (worth an
   independent, low-cost check: hit a `/_next/image?...` URL against
   `https://prereborn.ru` and see whether it 200s or 500s) or whether it's
   masked somehow. Needs a decision either way before `output: standalone`
   tracing is finalized, since the answer changes what the artifact must
   contain.
3. **Exact artifact size** was not empirically measured (would require
   running a real `next build --output standalone` + `pnpm deploy`, which
   this research phase deliberately did not do, per "don't start
   implementation"). The retention math in §9 is directional, not exact —
   measure for real in the implementation phase before finalizing the
   retention count.
4. **Node version on the production server** is documented only as "Node.js
   20+" (`docs/production-deployment.md:29`), while CI/the build runner pins
   Node 22. Not a blocker (the artifact only needs the server's Node to
   *run* compiled JS, and nothing in the dependency tree needs Node 22
   specifically at runtime), but worth pinning explicitly once this is
   implemented, so "built with Node 22, run with server's actual version"
   isn't a silent assumption.

---

# Part B — Piper removal

## Current fallback chain (verified in code, not assumed)

`apps/companion/src/chat/chat-model.ts:7`: `type TtsEngine = "system" | "piper"
| "silero"`. Default (`chat-model.ts:28`): `"silero"`. The Settings UI
(`TwitchChatPage.tsx:147-148`) only exposes two selectable radios — **Silero**
and **Piper** — `"system"` has never been user-selectable; it only exists as
the automatic last-resort inside the fallback chain.

Actual runtime chain, from `useTwitchChatSession.ts`:

- `ttsEngine === "silero"` → `speakWithSilero`. On failure/crash/unavailable →
  falls back to `speakWithPiper(..., "silero-fallback-piper")`
  (`useTwitchChatSession.ts:241`).
- `ttsEngine === "piper"` → `speakWithPiper` directly.
- `speakWithPiper`'s own catch falls back to `window.speechSynthesis`
  (`useTwitchChatSession.ts:141-154`, `195`).
- So today's real chain for the default (recommended) setting is: **Silero →
  Piper → system `speechSynthesis`** — a three-tier chain, not two.
- Piper is kept *enabled* (resources downloaded, sidecar allowed to run)
  whenever Silero is the active engine, specifically **because** Silero's own
  fallback needs Piper ready (`useTwitchChatSession.ts:332-335`: "Piper stays
  enabled whenever Silero is the active engine too, since Silero's own
  fallback chain needs Piper's resources/sidecar ready").

Target chain per this request: **Silero → system `speechSynthesis`.** Piper
removed from the chain entirely, not just demoted.

## Full dependency audit

Traced by actual IPC/dependency paths, not just `grep piper` (though that was
the starting point — 27 files matched across the repo). Grouped by surface:

**Rust / Tauri backend (`apps/companion/src-tauri/src/`):**

- `tts.rs` (842 lines) — the entire Piper engine: sidecar process management
  (`Sidecar::spawn`/`synthesize`/`kill`), resource download/extraction
  (`ensure_resources_blocking`, pulls from
  `github.com/.../releases/latest/download/piper-runtime-win-x64.zip` and
  `piper-voice-ru_RU-dmitri-medium.zip`), the WAV RIFF-chunk-size fix
  (`fix_wav_chunk_sizes` — a real bug workaround for this specific libpiper
  build, Piper-only), `TtsConfig`/`TtsState`/`TtsInner`, `init`/`status`/
  `set_enabled`/`synthesize`/`synthesize_base64`/`stop`. Entirely Piper-
  specific; **fully removable as a file**.
- `tts_common.rs` — **shared** with `silero.rs` (`to_short_path`,
  `sweep_stale_files`, `read_completed_file`, `spawn_stdout_reader`). Module
  doc comment (`tts_common.rs:1-8`) explicitly says both engines use this.
  **Must stay** — only its Piper-specific doc references need updating, not
  the code.
- `commands.rs:339-352` — `get_tts_status`, `set_tts_enabled`,
  `synthesize_piper_tts` `#[tauri::command]`s. Piper-only; removable. The
  Silero commands just below (`commands.rs:358+`) are untouched.
- `lib.rs` — `mod tts;` (`lib.rs:11`), `.manage(tts::TtsState::new())`
  (`lib.rs:116`), `tts::init(&handle)` (`lib.rs:129`), `tts::stop(app)` on the
  tray "quit" handler (`lib.rs:39`), and the three Piper commands in the
  `generate_handler!` list (`lib.rs:180`). All Piper-specific wiring;
  `mod tts_common;` (`lib.rs:12`) stays (shared).
- `diagnostics/tts_trace.rs` — `TtsTraceSource::PiperSidecar` enum variant
  (`tts_trace.rs:26`) and doc comments referencing "Piper sidecar stages".
  **Compatibility-sensitive**, see below.
- `diagnostics/session.rs` — one test asserts `engine: Some("piper".to_string())`
  and one uses `TtsTraceSource::PiperSidecar` as a test fixture value
  (`session.rs:739,757`) — test-only, update alongside the enum.
- `diagnostics/export.rs:153-155` — doc-comment text inside the diagnostics
  README generator explaining `"piper_sidecar"` as a possible `source` value
  in exported `tts-trace.json` files. Needs a wording update, not a logic
  change.

**Frontend (`apps/companion/src/`):**

- `services/dotaCompanionApi.ts` — `PiperTtsEngineState`, `PiperTtsStatus`
  types, `getPiperTtsStatus`, `setPiperTtsEnabled`, `synthesizePiperTts`
  bindings (lines 41-57). All Piper-only; removable. Silero's equivalent
  bindings (lines 59-77) are untouched (verified: no cross-references).
- `chat/chat-model.ts:7` — `TtsEngine` union includes `"piper"`; narrows to
  `"system" | "silero"`.
- `chat/useTwitchChatSession.ts` — `speakWithPiper` (the whole function),
  `piperStatus`/`piperBusy` state, `refreshPiperStatus`, the `piperActive`
  effect that calls `setPiperTtsEnabled`, and the dispatch branch `else if
  (settingsRef.current.ttsEngine === "piper")`. `speakWithSilero`'s catch
  block (currently calling `speakWithPiper(...)`, line 241) changes to call
  the system-`speechSynthesis` path directly.
- `components/TwitchChatPage.tsx` — the Piper radio button (line 148), the
  Piper status paragraph (lines 180-186), the Piper/espeak-ng GPL-3.0 license
  note (lines 187-188), and the destructured `piperStatus`/`piperBusy` props.
  The Silero radio/status block stays, its copy simplifies (no more "Piper
  недоступен, читаем системным голосом" — that sentence's meaning transfers
  to Silero's own status line, which already says "автоматически
  переключаемся на Piper, затем на системный голос" and needs to become
  "...автоматически переключаемся на системный голос").
- `chat/hotkey-format.ts:20-21` — a comment mentioning "Silero/Piper/OBS
  ecosystem" as context for F-key binding conventions. Cosmetic, optional
  wording fix, zero functional coupling.

**Release pipeline / assets:**

- `.github/workflows/windows-release.yml` — the "Build + package Piper TTS
  runtime and voice" step (lines 179-189) and the `piper-dist/*.zip`,
  `piper-dist/*.sha256` entries in the release `files:` list (lines 224-225).
  Removable independently of the Silero step below it (already independent
  today per the existing comment at line 198: "Independent of the Piper step
  above").
- `scripts/companion-build-piper-runtime.ps1` (125 lines) — clones
  `OHF-Voice/piper1-gpl`, locates MSVC via `vswhere`, does a full CMake/Ninja
  native C++ build of `libpiper` (linking `onnxruntime`), downloads the voice
  model from Hugging Face, smoke-tests real synthesis, packages two zip
  assets. Fully removable as a file.
- `scripts/companion-piper-smoke-phrase.txt` — input fixture for the above
  script's smoke test. Removable alongside it.
- `scripts/companion-checksums.ps1`, `companion-smoke-test.ps1`,
  `companion-verify-installer.ps1`, `companion-generate-update-manifest.ps1`
  — grepped for `piper`/`Piper`: **zero matches in all four**. None of them
  reference Piper assets; the updater manifest (`latest.json`) never included
  `piper-dist/*` at all (it only manifests the installer `.exe`/`.sig`, since
  Piper/Silero resources are downloaded by the running app, not bundled in
  the installer or tracked by the updater). No changes needed here.

**Tests:**

- `apps/companion/src-tauri/src/tts.rs` — its own `#[cfg(test)] mod tests`
  (Piper-specific WAV-fixing unit tests + three `#[ignore]`d real-subprocess
  integration tests gated on `PIPER_TEST_*` env vars). All removable with the
  file.
- `apps/companion/src/chat/useTwitchChatSession.test.tsx` — mocks
  `getPiperTtsStatus`/`setPiperTtsEnabled`/`synthesizePiperTts` (lines 15-17),
  and has one test that specifically asserts the Silero→Piper fallback:
  `"falls back from Silero to Piper when Silero synthesis fails, and keeps
  draining the queue"` (line 149). **This test must be rewritten**, not just
  deleted — its actual purpose (proving a failed Silero synthesis doesn't
  strand a queued message) is exactly the "must not regress" scenario the
  user named ("fallback при падении Silero"). New version: assert Silero
  failure results in the message being spoken via `window.speechSynthesis`
  (already mockable in jsdom per the existing `HTMLMediaElement`/`Audio`
  stubbing pattern in that file's `beforeEach`).
- `chat-model.test.ts` — comments reference the three-tier fallback
  (`"WK-81: Silero is the primary engine now (Piper/system remain available
  as fallbacks...)"`, line 21-22) — no actual `piper` assertions found in this
  file, just explanatory comments to update.

**Documentation (informational, not functional — lower priority but listed
per the audit request):** `docs/companion-release.md` (no Piper references
found — clean), `docs/research/companion-tts-voice-comparison.md`,
`docs/research/local-tts-licensing.md`, `docs/research/wk-74-*.md` (3 files),
`docs/research/wk-77-tts-quality-audit.md`, `docs/research/wk-78-*.md`,
`docs/research/wk-81-silero-tts-feasibility.md` — all historical
research/decision records that *explain why Piper was built*. **Recommendation:
leave these untouched** — they're dated research artifacts, not living
documentation, and rewriting history here would destroy the record of a real
past decision (the GPL-3.0 subprocess-boundary reasoning in
`local-tts-licensing.md` in particular remains historically accurate and
potentially relevant if a future engine choice raises the same licensing
question again).

## Measured pipeline time breakdown

Pulled from `gh run view` on real, completed runs (2026-08-22) — not
estimated. Two different pipelines, kept separate:

**Web/API deploy (`deploy-production.yml` run `32589954814` + CI run
`32589803601`)** — see Part A §1 table; irrelevant to Piper, reproduced there
only.

**Companion release (`windows-release.yml`, tag `prereborn-v0.5.18`, run
`32586082157`, `release-windows` job):**

| Stage | Step name | Measured duration |
|---|---|---|
| Setup (checkout, pnpm, Node, Rust toolchain + cache, `pnpm install`) | multiple | ~1m17s |
| **Companion build** | "Build Tauri app (Windows installer)" — Rust + Tauri + Vite frontend | **6m53s** |
| Smoke test + checksums | | ~27s |
| **Piper runtime/model build** | "Build + package Piper TTS runtime and voice" — clone `piper1-gpl`, MSVC/CMake/Ninja native build, download voice, smoke-test, package 2 zips | **3m02s** |
| **Silero runtime/model build** | "Build + package Silero TTS runtime and model" — portable Python 3.12 + PyTorch CPU + sidecar script + `v5_5_ru` model, package | **14m20s** |
| Manifest + GitHub Release publish | | ~47s |
| **Total job** | | **~28m6s** |

**This corrects an assumption in the request, worth stating plainly:** Piper's
own build step (3m02s) is **not** the dominant cost in this pipeline — Silero's
build step is, at roughly **4.7× Piper's duration** (14m20s vs 3m02s), and the
Companion Rust/Tauri build itself (6m53s) is also larger than Piper's step.
Removing Piper saves a real but modest ~3 minutes of the ~28-minute release job
(~11%), not "most of the release time."

What Piper removal *does* remove, and this is closer to the actual value the
request's own reasoning names (separate runtime lifecycle, extra release
assets, extra failure surface — not raw CI minutes):

- An entire native-C++ toolchain dependency in the release job: `git clone` of
  an external GPL-3.0 repo, `vswhere`-based MSVC discovery, CMake/Ninja
  configuration, linking against `onnxruntime` — a qualitatively different (and
  more fragile — MAX_PATH issues, compiler discovery, DLL colocation, all
  documented as real gotchas in `docs/research/wk-74-libpiper-ci-spike.md`)
  build step than either the Tauri build or Silero's Python-download-based
  approach.
  the pip
- Two release assets (`piper-runtime-win-x64.zip`, `piper-voice-ru_RU-dmitri-
  medium.zip`, ~30MB combined per `tts.rs:36`'s comment) that every user who
  ever enables TTS downloads once, on top of Silero's own (larger) resource
  download.
- A second first-run download/extract/health-check code path
  (`ensure_resources_blocking`, `resources_ready`, `Sidecar::spawn` — all
  Piper-specific) that has to be kept correct and tested independently of
  Silero's equivalent.
- A GPL-3.0 subprocess/IPC licensing boundary (`local-tts-licensing.md`) that
  only exists because Piper (via `espeak-ng`) is GPL — Silero's model license
  (CC BY-NC-SA 4.0, per `TwitchChatPage.tsx:177`) is a different, already-
  accepted constraint that isn't affected by removing Piper.

## First-run / update / orphaned-data scenarios

Checked all four scenarios the request named:

1. **New user, fresh install.** Never had Piper. No orphaned files possible.
   Unaffected by any migration choice.
2. **Existing user who already downloaded Piper's engine+voice** (i.e.
   `app_data_dir()/tts/engine/` and `.../tts/voices/` are populated, ~30MB —
   `tts.rs:76-99` defines these paths). After the update, nothing in the new
   binary ever reads or writes those paths again (the whole `tts.rs` module is
   gone). The files become inert — not referenced, not loaded, not executed.
3. **User with saved Piper-related settings** (`localStorage`'s
   `chat-model.ts`-defined `STORAGE_KEY` blob may contain `ttsEngine: "piper"`
   from before the update). `loadSettings()`
   (`useTwitchChatSession.ts:35-36`) does `{ ...DEFAULT_CHAT_SETTINGS,
   ...JSON.parse(saved) }` — a saved `"piper"` value would **override** the new
   default (`"silero"`) verbatim, and after the "piper" branch is deleted from
   both the settings UI and the dispatch logic in `useTwitchChatSession.ts`,
   that persisted string would match neither remaining `if`/`else if` branch
   (only `"silero"` is explicitly checked; see `useTwitchChatSession.ts:268-
   269`) and messages would silently stop being spoken at all for that user —
   a real regression, not a hypothetical one.
4. **Update from an old Companion version to the new one**, same underlying
   case as #3 for anyone who had explicitly picked Piper before.

**Decision needed at implementation time, recorded here as the recommendation:**
add a one-line, pure-data coercion in `loadSettings()` — if the loaded
`ttsEngine === "piper"`, coerce it to `"silero"` before merging. This is a
values-only migration (no file I/O, no deletion, can't fail, can't lose data)
and makes the update transparent: a user who had Piper selected simply starts
using Silero (already the recommended engine) after updating, with no crash,
no silent muting, and no visible "your setting was reset" moment beyond the
engine itself changing.

## A vs. B: orphaned Piper files on disk

Per the request's framing — evaluated both options:

- **(A) Leave old Piper files on disk as orphaned data.** ~30MB in
  `app_data_dir()/tts/{engine,voices}/`, never read or written again post-
  update. Costs the user a few tens of MB of disk they're extremely unlikely
  to notice or care about (this is exactly the kind of app-data footprint
  users never audit). Zero code risk: doing nothing can't introduce a bug.
- **(B) Actively delete them at startup/migration.** Requires new startup
  code that runs unconditionally for every user (not just the small minority
  who ever enabled Piper) to check-and-maybe-delete two directories, adds a
  new filesystem-deletion code path that has to handle "directory doesn't
  exist," "partially deletable" (locked file, permissions), and "deletion
  fails" without turning into a startup error for users who never had Piper
  at all.

**Recommendation: (A).** The request's own stated preference — "не добавлять
сложную migration только ради очистки нескольких десятков MB, если она
создаёт дополнительный риск" — is correct here: the cleanup value (tens of MB,
on a desktop app, for users who won't notice) is far smaller than the risk
surface of adding unconditional startup filesystem-deletion code that every
single user's install now runs through, including the vast majority who never
touched Piper. If disk footprint ever becomes a real complaint, a targeted,
optional "clear TTS cache" button in Settings would be a much lower-risk way
to offer cleanup than an automatic migration — not proposed as part of this
implementation, just noted as the better future option if ever needed.

## Compatibility impact summary

- **Settings:** one-line coercion (above) — no UI-visible break for any
  existing user.
- **Diagnostics exports:** old exported `tts-trace.json`/session bundles that
  contain `"source": "piper_sidecar"` remain valid, readable JSON regardless
  of what the *current* binary does — this is data already written to disk by
  a past version, not something the new binary re-parses or validates
  against its own enum. **Decision:** keep the `PiperSidecar` variant in
  `TtsTraceSource` (`tts_trace.rs:26`) even though nothing will ever produce
  it again after removal — removing the enum variant entirely would only
  matter if the current binary ever *deserializes* old trace files, which it
  doesn't (diagnostics export is write-only from the running session; nothing
  reads historical `tts-trace.json` back in). Keeping the variant costs
  nothing and avoids a footgun if that ever changes. Update its doc comment to
  say "historical, no longer produced" instead of describing live behavior.
- **No named regression risk found** for the six scenarios the request called
  out to protect (TTS queue, skip hotkey, consecutive-author suppression,
  nickname pronunciation overrides, mixed-script normalization, Silero voice
  selection) — none of the code implementing those lives in `tts.rs`,
  `commands.rs`'s Piper commands, or the Piper branches being removed from
  `useTwitchChatSession.ts`/`TwitchChatPage.tsx`. They live in
  `tts-normalize.ts`, `chat-model.ts`'s queue logic, and Silero-specific code
  paths that this removal doesn't touch. The one place that **does** need
  care, called out above, is rewriting (not deleting) the Silero-failure
  fallback test so the "never strand a queued message" guarantee stays
  covered.

## Piper removal implementation checklist

For the implementation phase, after design review:

**Remove entirely:**
- `apps/companion/src-tauri/src/tts.rs`
- `apps/companion/src-tauri/src/commands.rs`: `get_tts_status`,
  `set_tts_enabled`, `synthesize_piper_tts`
- `apps/companion/src-tauri/src/lib.rs`: `mod tts;`, `.manage(tts::TtsState::
  new())`, `tts::init(&handle)`, `tts::stop(app)` call, the three Piper
  command registrations in `generate_handler!`
- `apps/companion/src/services/dotaCompanionApi.ts`: `PiperTtsEngineState`,
  `PiperTtsStatus`, `getPiperTtsStatus`, `setPiperTtsEnabled`,
  `synthesizePiperTts`
- `apps/companion/src/components/TwitchChatPage.tsx`: Piper radio button,
  Piper status paragraph, Piper/espeak-ng license note
- `.github/workflows/windows-release.yml`: "Build + package Piper TTS runtime
  and voice" step, `piper-dist/*` entries in the release `files:` list
- `scripts/companion-build-piper-runtime.ps1`,
  `scripts/companion-piper-smoke-phrase.txt`
- `apps/companion/src-tauri/src/tts.rs`'s own test module (goes with the file)

**Modify (not remove):**
- `apps/companion/src-tauri/src/tts_common.rs` — doc comments only (drop
  Piper-specific framing, keep as "shared sidecar IPC primitives, currently
  used by Silero")
- `apps/companion/src/chat/chat-model.ts` — `TtsEngine` narrows to `"system" |
  "silero"`
- `apps/companion/src/chat/useTwitchChatSession.ts` — remove
  `speakWithPiper`, `piperStatus`/`piperBusy` state, `refreshPiperStatus`, the
  `piperActive` effect; `speakWithSilero`'s failure path calls the system-
  speech function directly; remove the `ttsEngine === "piper"` dispatch
  branch; **add** the `loadSettings()` coercion (`"piper"` → `"silero"`)
- `apps/companion/src-tauri/src/diagnostics/tts_trace.rs` — keep
  `TtsTraceSource::PiperSidecar`, update its doc comment to "historical only"
- `apps/companion/src-tauri/src/diagnostics/session.rs` — update the two
  tests using `"piper"`/`PiperSidecar` as fixture values to use `"silero"`/
  `SileroSidecar` (or explicitly keep one as a regression test that old-format
  historical values still parse — either is defensible, pick one during
  implementation)
- `apps/companion/src-tauri/src/diagnostics/export.rs` — update the
  `tts-trace.json` format doc comment to describe `"piper_sidecar"` as a
  legacy value, not a currently-producible one
- `apps/companion/src/chat/useTwitchChatSession.test.tsx` — rewrite (not
  delete) the "falls back from Silero to Piper" test to assert Silero →
  system `speechSynthesis`; remove the three `PiperTts*` mocks
- `apps/companion/src/chat/chat-model.test.ts` — update the WK-81 comment
  referencing the three-tier chain
- `apps/companion/src/chat/hotkey-format.ts` — optional comment wording fix

**Leave untouched:** `apps/companion/src-tauri/src/silero.rs`,
`scripts/companion-build-silero-runtime.ps1`, everything in
`docs/research/` (historical record, see rationale above),
`docs/companion-release.md` (no Piper references found).

**Verification before shipping:** confirm no other `#[tauri::command]` or
frontend code path still references `synthesize_piper_tts`/`get_tts_status`/
`set_tts_enabled` by name (those command names are string-matched by Tauri's
IPC dispatch, so a stray frontend `invoke("get_tts_status", ...)` left behind
would fail silently at the IPC layer rather than at compile time) — a repo-
wide grep for the exact command name strings, not just the word "piper", is
the right check.
