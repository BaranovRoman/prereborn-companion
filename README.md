# PreReborn Companion

PreReborn Companion is an in-development toolkit for Dota streamers. It
combines a local Tauri GSI companion, a web control surface, an API, OBS
overlays, and an anti-stream-snipe queue scene.

## Status

The project is being extracted from the `portfolio` monorepo. Production
temporarily continues to run from that monorepo while a dedicated domain,
public API, deployment, and compatibility cutover are prepared.

Implemented areas include local GSI capture, companion-token authentication,
stream sessions and match history, public OBS overlays, overlay layout editing,
Steam/OpenDota integration, Twitch channel OAuth with live status and embedded
chat, and the queue scene. Goals and supporter data shown in the queue-scene
mock are not live integrations.

## Architecture

- `apps/web`: Next.js control pages and public OBS scenes.
- `apps/api`: Express/PostgreSQL stream and companion API.
- `apps/companion`: React/Vite application hosted by Tauri 2.
- `docs`: extraction, transition, and deployment notes.

## Local development

Install Node.js 20+, pnpm 10, PostgreSQL, Rust, and the Tauri platform
prerequisites.

```bash
pnpm install
cp .env.example .env
pnpm dev
```

Run individual applications with:

```bash
pnpm --filter @prereborn/web dev
pnpm --filter @prereborn/api dev
pnpm --filter @prereborn/companion dev
pnpm --filter @prereborn/companion tauri dev
```

Apply only the local product migration:

```bash
pnpm --filter @prereborn/api db:migrate
```

## Build and test

```bash
pnpm build
pnpm lint
pnpm typecheck
pnpm test
pnpm check:rust
```

Environment variables are documented in `.env.example`. Empty values disable
the corresponding optional integration. Do not reuse production secrets in a
development checkout.

## Domains and production

The dedicated public API and product domain are not finalized. Local builds
use `127.0.0.1:3001`; production builds must provide the future dedicated API
URL through environment-specific configuration. See `docs/extraction-plan.md`
for the cutover workflow.

## Trademark and third-party notice

This repository is not affiliated with or endorsed by Valve. Dota, Dota 2,
Steam, Valve, and related third-party materials belong to their respective
rights holders and are not licensed under this repository's MIT license. See
[THIRD_PARTY_ASSETS.md](THIRD_PARTY_ASSETS.md).
