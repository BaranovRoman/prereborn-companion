# Companion visual QA harness

The real Companion shell in a normal browser: Tauri IPC is mocked with realistic
fixtures (`fixtures.ts`), and the real Dota plugin UI is loaded into the real
sandboxed plugin iframe through the same `postMessage` bridge. Nothing here is
part of the production build. `vite build` has a single `index.html` input, and
`tsconfig.json` only includes `src/`.

## Run

Start three dev servers, each in its own terminal:

```bash
# Dota plugin UI, served where the plugin iframe requests it (:1431)
cd plugins/dota/ui && pnpm exec vite --config vite.qa.config.ts
# OBS overlay renderer for the editor preview (127.0.0.1:3666/overlay)
cd plugins/dota/ui && pnpm exec vite --config vite.qa-overlay.config.ts
# Companion shell with mocked IPC (http://localhost:1430/)
cd apps/companion && pnpm exec vite --config qa/vite.config.ts
```

Open `http://localhost:1430/?scenario=default`. The scenarios are `default` (a
mid-stream session), `empty` (a fresh install with nothing connected) and
`errors` (OBS down, Twitch scope missing, hotkey conflict, Silero crashed).

## Screenshots and layout check

```bash
PLAYWRIGHT=$PWD/node_modules/.pnpm/playwright@1.62.0/node_modules/playwright/index.mjs \
SCENARIOS=default,errors \
node apps/companion/qa/screenshots.mjs /tmp/qa 1920x1080 2560x1440 1280x720 1024x720
```

This captures every Companion section and every Dota tab, including the overlay
editor's «Игра» scene and its scrolled state. It writes `layout-report.json`
and prints a `CHECK` line for any screen that has more than one vertical scroll
container (host plus plugin) or horizontal page overflow. A bounded internal
scroll that is meant to be there, such as the diagnostics JSON block, will
also show up in that list.

Judge the composition at 1920×1080 first and check it at 2560×1440, as
described in CLAUDE.md "Companion UI visual QA". 1024×720 is only a check that
nothing breaks.
