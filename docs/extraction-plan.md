# PreReborn Companion extraction plan

## Scope

The source remains in `D:\Sites\portfolio` until the new domain and production
deployment are verified. The extraction target is
`D:\Sites\prereborn-companion`. No Git history, production database, uploads,
logs, diagnostics exports, tokens, installers, or deployment state are copied.

## Current architecture map

### Desktop companion

- Source: `apps/dota-companion`
- React/Vite frontend with a Tauri 2 Rust host.
- Installs and receives Dota GSI locally, stores a companion token, sends GSI
  state to the API, and can export redacted diagnostics.
- Has no workspace package imports, but its package name, CI paths, release tag
  convention, default backend URL, and documentation are tied to `portfolio`.

### Web and OBS surfaces

- Routes: `packages/frontend/app/stream/**` and
  `packages/frontend/app/overlay/[publicToken]`.
- Components: `packages/frontend/src/components/pages/stream/**` and
  `packages/frontend/src/components/pages/overlay/**`.
- Domain models and clients:
  `stream-user`, `stream-session`, `stream-overlay-layout`, and `dota-hero`.
- Queue scene includes WebGL shaders, layered tree artwork, mock dashboard data,
  and Playwright coverage.
- The current Next application imports portfolio-wide layout, providers,
  analytics, API helpers, and dependencies. The extracted web app needs a small
  product-specific layout and localized HTTP clients rather than the complete
  portfolio frontend.

### API and database

- Stream routers: auth, account, overlay, integrations, and companion.
- Stream controllers/services plus Steam OpenID, OpenDota sync, companion token
  authentication, session auth, CORS, error handling, rate limiting, PostgreSQL
  client, and logging.
- Stream tables currently live inside the portfolio's monolithic migration.
  They must be moved into a product-only migration without portfolio case,
  contact, admin, effect, or solitaire tables.
- No production database or migration execution is part of extraction.

### CI and deployment

- `.github/workflows/dota-companion-build.yml` builds Windows installers and
  publishes tag releases, but paths, package filters, and tag names assume the
  portfolio monorepo.
- Root Docker, nginx, PM2, and deploy files combine unrelated portfolio
  services. Product-specific replacements are required; current production
  configuration remains untouched.

## Target structure

```text
prereborn-companion/
  apps/
    web/
    api/
    companion/
  docs/
  .github/workflows/
  package.json
  pnpm-workspace.yaml
  pnpm-lock.yaml
  README.md
  LICENSE
  THIRD_PARTY_ASSETS.md
  .env.example
  .gitignore
```

No shared package is introduced initially: current code has no real
`workspace:*` contract worth extracting. Shared types can be introduced later
only after web/API drift is measured.

## Dependency and security risks

1. The web surface currently depends on portfolio-wide Next configuration and
   shared API helpers.
2. The API migration is monolithic and must not carry unrelated schema.
3. `DEFAULT_BACKEND_URL` in the Tauri application points to
   `https://baranov-digital.ru/api`; it remains the compatibility default until
   the domain cutover, but must be documented and made configurable.
4. Steam realm/return URL, CORS origins, download URL, cookie behavior, and OBS
   URLs require coordinated cutover.
5. Companion tokens, JWT secrets, Steam IDs, database rows, GSI payloads, and
   diagnostics archives are sensitive and must never enter the public tree.
6. Installer binaries and Rust/Node build directories are excluded.
7. The three `trees-*.png` files have no recorded source. They remain
   third-party/origin-unknown until provenance is supplied.
8. No video files are currently present in the audited source tree.

## Repository-hosted video decision

Video will be committed directly under
`apps/web/public/vendor/valve/video/`. Git LFS is not enabled initially.
Every file must be registered in `THIRD_PARTY_ASSETS.md` before commit.

This favors predictable OBS/browser-source availability and keeps deployment
self-contained. The costs are larger clones, Git history growth, GitHub
bandwidth pressure, and harder legal removal because old blobs remain in
history. Replacement media should use new filenames and immutable caching.
If repository size becomes operationally expensive, a later migration to
release assets or a CDN requires an explicit decision and migration plan.

## Temporary two-copy workflow

1. The new repository becomes the development source after its initial commit.
2. Until domain cutover, production-critical fixes are implemented in the new
   repository first and manually backported to `portfolio` as a named commit.
3. After the extraction validation milestone, feature work directly in the old
   copy is prohibited.
4. Database migrations and API contract changes require the same migration ID
   and payload shape in both copies until cutover.
5. No automatic sync is introduced; a short-lived manual backport ledger is
   maintained in `docs/transition-ledger.md`.

## Cutover checklist

- Configure the web domain and API domain/path.
- Update CORS, secure cookie domains, Steam OpenID return URL, Twitch callback,
  Tauri backend/updater endpoints, download links, and OBS Browser Source URLs.
- Keep the old API compatible with released companion versions during a
  transition window.
- Add redirects, verify production and installers, then remove the implementation
  from portfolio while retaining a case-study link.

## Extraction stages

1. Audit and dependency map (this document).
2. Create the autonomous product-only tree and public documentation.
3. Install from a clean dependency state; run web/API builds, lint, TypeScript,
   unit/Playwright checks, Cargo checks, and secret scans.
4. Review the complete file list and exclusions, initialize a clean Git
   repository, and prepare—but do not push—the initial commit.
