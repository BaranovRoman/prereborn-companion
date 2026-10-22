# PUBG plugin (WK-183)

Installable live worker (`id: pubg`, API 2, Windows) that shows a PUBG player's recent
matches (map, place, kills, damage, mode, finish time) and an optional OBS widget with the
current session's matches. No PUBG-specific code lives in Companion: the plugin uses the
generic plugin runtime, its signed manifest grants and the host's backend transport.

## How it works

- **Data source.** The official PUBG Developer API, only through the Prereborn backend:
  `GET /api/stream/integrations/pubg/matches?platform=&player=&limit=` (manifest resource
  `matches`). The API key is `PUBG_API_KEY` on the server (see
  `docs/operations/production-env.md`); it is never in the package. Without it the route
  answers `not_configured` and the UI says so.
- **Polling.** One request in flight, planned by the worker on the host's `host.poll`;
  the host performs the HTTP call off the IPC thread. Every 60 s normally, 5 s while the
  backend is still loading match details (`complete: false`), 90 s after `rate_limited`,
  5 min for `player_not_found`/`not_configured`, exponential backoff (15 s → 5 min) for
  other failures. API errors are statuses, never worker errors, so they cannot stop the
  plugin or Companion.
- **Session.** Starts when the worker is activated: with «Запускать вместе с Companion»
  that is each Companion launch. A match belongs to the session when it finished
  (`createdAt` + duration) at or after the session start, so a match already running at
  launch counts, and a late API result still counts by its finish. No manual session controls.
- **History.** `plugins/data/pubg/history.json`, deduplicated by match id, newest first,
  at most 200, kept across launches. Changing nickname or platform starts a new history.
- **Latency diagnostics.** `plugins/data/pubg/diagnostics.log` (JSON lines, 256 KB + one rotated
  file): each backend request/response, every new match with seconds since its finish and the
  backend's `timing` (when it first saw the match in the player's list), and when the widget
  published and an open page first read it. See `docs/research/pubg-widget-latency.md`.
- **Settings.** `plugins/data/pubg/settings.json`: nickname, platform
  (`steam`/`kakao`/`psn`/`xbox`) and widget options. Edited only in the plugin UI.
- **OBS widget.** While the plugin is enabled the worker serves
  `http://127.0.0.1:3667/pubg/widget` (the signed `ui/widget/index.html`) and its state at
  `/pubg/widget/state`. Transparent page, polls every 2 s and redraws when the state's
  content changes. In OBS it renders nothing when it is turned off or the session has no
  matches; opened in an ordinary browser it says why instead (off, no nickname, no
  finished match yet, no connection to the plugin). Options: on/off, 3–10 matches, scale
  50–200 %, background opacity, column headers.

The plugin does not read game memory, the game process or the anti-cheat.

## Build and test

```bash
cargo test --manifest-path plugins/Cargo.toml -p companion-pubg-plugin
pnpm --filter @prereborn/pubg-ui test
pnpm --filter @prereborn/pubg-ui build        # dist/ (UI) + dist/widget/index.html
pnpm --filter @prereborn/pubg-ui test:e2e     # after build: finished match → worker → /pubg/widget in Chromium
```

## Release

Same pipeline as the Dota plugin, with the PUBG inputs:

1. Bump `version` in `Cargo.toml` and `manifest.windows-live.json` (the worker refuses a
   mismatch; `tests/manifest.rs` checks it), and add the Russian user-facing entry for that
   version to `changelog/plugins/pubg.md` (`changelog/README.md`). CI and the candidate job fail
   without it.
2. `gh workflow run windows-release.yml --ref codex/plugin-runtime-prototype -f pubg_candidate=true`
   → artifact `pubg-windows-candidate` (exe + `pubg/ui/dist`).
3. Locally: `package.py package --binary <exe> --ui <dist> --manifest-template plugins/pubg/manifest.windows-live.json
   --platform windows --arch x86_64 --url https://github.com/BaranovRoman/prereborn-companion-plugins/releases/download/pubg-vX.Y.Z`,
   then `package.py catalog` with every existing `catalog-v1` release plus the new one.
4. Dispatch again with `-f pubg_candidate=true -f pubg_candidate_metadata=gz:<base64 gzip>`
   to verify the signed package and catalog on Windows.
5. `gh release create pubg-vX.Y.Z --notes-file <(node scripts/changelog.mjs notes plugin pubg X.Y.Z)`
   (zip + release.json) in `prereborn-companion-plugins`,
   then upload `catalog.json` + `catalog.minisig` to `catalog-v1`.
