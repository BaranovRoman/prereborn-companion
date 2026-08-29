# WK-121: Companion Product Consolidation

Status: IN PROGRESS (living document, updated as the slice lands)
Branch: `feat/wk-121-companion-product-consolidation`
Baseline: `prereborn-v0.5.43` (companion app version `0.4.0`)

## 0. Scope

One large product slice for `apps/companion` (Tauri desktop app): a Dota-like UI foundation, an
uncapped responsive shell, Settings reworked by ownership, a new "Герои" section with hero detail
pages and hero-specific Game Sounds, and finishing the WK-120 local-overlay cutover so a real OBS
Browser Source can point at `127.0.0.1:3666/overlay` instead of the legacy `prereborn.ru` overlay.

## 1. Pre-work audit findings (source of truth before writing any code)

### 1.1 App shell / width cap / nav (today)

- Shell: `apps/companion/src/components/AppShell.tsx`, hardcoded `Section` union + `useState`, no
  router. Nav today: Главная / Чат / Звуки in the header tab group, Диагностика as a secondary
  link, gear icon opens `SettingsModal` (Settings is not a nav tab).
- Width caps: `.main > * { max-width: 1480px; ... }` (`App.css:450`) and the Settings modal
  `width: min(1600px, 90vw); height: min(920px, 90vh)` (`App.css:690-692`).
- Design tokens: `App.css:1-46`, deliberately the same CSS variable names/values as
  `apps/web`'s stream dashboard (`--ui-void/-well/-panel/-raised/-edge`, `--radius: 1px`,
  `--ui-gold/-red/-cyan/-green`). This is already a real "Dota-like" palette — kept as-is, no new
  palette introduced.
- No component primitives exist — every control is a native `<button>/<input>/<select>` styled by
  shared class names in one 1087-line `App.css`.

### 1.2 Settings (today)

- `SettingsModal.tsx`: category rail + content pane, categories today: Подключение
  (`CompanionTokenForm`), OBS (`ObsScenePanel`), Горячие клавиши (`HotkeySettings`, only the
  skip-TTS hotkey binding), Запуск (`AutostartSetting`).
- TTS/chat behavior settings (enabled, engine, voice, volume, speak-author, max length,
  per-username pronunciation, notification sound) all live inline in `TwitchChatPage.tsx`'s
  `<aside className="chat-settings">` — not in Settings at all. This is the ownership violation
  WK-121 §4 asks to fix.

### 1.3 Companion Token — investigation result

**Verdict: cannot be removed from user-facing UX in this slice; documented as a transitional
credential, not an auth session.**

- It is an **opaque, server-generated secret** (`crypto.randomBytes(32).toString("base64url")`,
  `apps/api/src/services/stream-user-service.ts:221-222`), stored **hashed** (SHA-256) in
  `stream_users.companion_token_hash`, verified by hash lookup in
  `apps/api/src/middleware/authenticate-companion-token.ts` — not a JWT, not a session, a bearer
  machine-credential in the classic "API key" sense.
- It is genuinely load-bearing: used as the bearer credential for every backend sync/status call
  Companion makes (`backend/mod.rs`, `local_runtime/sync.rs`), stored locally
  (`storage/mod.rs:save_companion_token`), explicitly redacted from diagnostics dumps and the local
  overlay server's served fields.
- It is generated/revealed **once** on the website (`apps/web/.../companion-panel.tsx`, under
  `/stream` → "Companion"), then pasted into `CompanionTokenForm.tsx` in the app. This reveal-once
  + copy/paste UX is what §5 flags as suspicious.
- **Why it can't simply be removed this slice**: Companion has no authenticated desktop session of
  its own — no OAuth/device-code flow, no way to prove "this install belongs to streamer X" other
  than presenting this secret. Replacing it with "Companion login → automatic provisioning" needs a
  new auth flow (device-code or embedded browser + PKCE against the existing web session system)
  designed and built in `apps/api`, which is real new auth surface, not a Companion-only UI change
  — exactly the kind of change the ticket's own "не ломай existing auth до безопасной migration"
  guardrail exists for.
- **What shipped instead (transitional)**: `CompanionTokenForm` already links out to
  `/stream → Companion` rather than asking the user to construct a token themselves; kept as-is.
  The real fix — a device-code-style login — is logged as explicit follow-up work, not attempted
  here (see §9).

### 1.4 Hero catalogs — real duplication confirmed, consolidation plan

Three independently-maintained hero lists from the same OpenDota snapshot:

1. `apps/web/src/entities/dota-hero/model/heroes.ts` — richest: id/name/localizedName/attribute
   **+ imageUrl/videoUrl/featuredVideoUrl/favoriteVideoUrl**. Has RU alias map
   (`model/aliases.ts`) and search (`lib/search.ts`).
2. `apps/companion/src/services/heroCatalog.ts` + `heroAttributes.ts` — TS-only, presentation-only
   bridge added WK-116 (tag v0.5.41), explicitly "ported from web", no video fields, no RU aliases,
   simpler substring search (`HeroesGrid.tsx`).
3. `apps/companion/src-tauri/src/game_sounds/generated_hero_catalog.json` +
   `catalog.rs::hero_catalog()` — the **authoritative Rust catalog** that actually powers Game
   Sounds detection (ability ids, Techies/Rubick/Invoker special-casing, hidden sub-effects). This
   one is untouched by WK-121 — it's correct and load-bearing.

**Decision**: consolidate within `apps/companion` only (no cross-app package extraction this
slice — that's a separate, larger refactor with its own risk profile). `heroCatalog.ts` becomes
the **one** TS-side hero catalog for Companion: extended with RU alias search (ported from
`aliases.ts`) and hero video/portrait URLs (ported from `heroes.ts`'s `buildMediaUrl` pattern,
same Valve CDN + PreReborn media-mirror URLs, no new asset pipeline). Both the new Heroes section
and the existing Sounds → Heroes grid consume this one file. The Rust ability catalog stays the
single source of truth for ability data; the new Hero Detail page's ability cards call the same
`get_settings`/`set_binding`/`remove_binding`/`preview_sound`/`import_and_bind` commands
`HeroAbilitiesModal.tsx` already uses today — no parallel sound-mapping model.

### 1.5 Favorites — real source of truth, consolidation plan

Favorites (`favoriteHeroIds: number[]`) live entirely in the **web account backend**
(`GET/PUT /account/me/queue-settings`, `apps/web/src/entities/stream-queue-settings`), authenticated
via `authenticateStreamUser` (web session JWT) — **not** reachable with the Companion Token today.
Companion has never had any favorites concept. This is the real reason a second implementation
would be tempting — and exactly what §6 forbids ("не создавать favoriteHeroesV2").

**Decision**: expose the *same* `favoriteHeroIds` field, backed by the *same*
`stream-queue-settings-service.ts` row, through a new companion-token-authenticated endpoint
(`GET/PUT /companion/favorite-heroes`, mounted on the existing `authenticateCompanionToken` router
next to the other companion-scoped routes) rather than inventing local-only storage. One row, two
credentials that can read/write it, zero new entities. This is a small, additive backend change
(new route + reusing the existing service function, which already just takes a resolved stream
user id) — not a new data model, and does not touch the web-session path at all. Companion's
Heroes screen calls this endpoint the same way `backend/mod.rs` calls other companion-token routes
today.

### 1.6 Overlay renderer / OBS — current state

- Production renderer: `apps/web/src/components/pages/overlay/*` (`OverlayCanvas`,
  `AnchoredWidget`, widget set), virtual canvas 1920×N (16:9 by default), tightly coupled to
  Next.js routing + `apps/api` REST polling. Confirmed dead widgets (Fake Picker / Cinematic Draft)
  must not be reintroduced (WK-69 removal, confirmed still absent).
- WK-120 delivered: canonical `BroadcastState` (Rust, `broadcast_state.rs`), local server
  `127.0.0.1:3666` with `/overlay/health`, `/overlay/state` (full snapshot), `/overlay/events`
  (SSE, sends initial snapshot + live diffs, loopback-only, no secrets in payload). `/overlay`
  itself still serves an explicitly-labeled **dev-preview** page, not production pixels — this is
  the gap WK-121 closes.
- OBS integration: a real `obs-websocket` client already exists (`obs.rs`) for scene switching
  (`GetSceneList`, `SetCurrentProgramScene`) — **no** Browser-Source URL read/write capability
  (`GetInputSettings`/`SetInputSettings`) exists yet.
- Legacy web overlay must stay: it's the only thing any unmigrated production Browser Source uses,
  the only thing a direct viewer/mod URL can hit (local overlay is inherently single-machine), and
  it carries a real safety behavior local-only cannot replicate — the companion-offline
  draft-protection fallback (if Companion crashes mid-draft, the local overlay dies with it; the
  web overlay, backed by `apps/api`'s last-known state, can still show a protective Draft cover).
  **Decision**: keep the legacy overlay indefinitely as the always-available multi-consumer +
  companion-crash-safety path; local overlay is additive, not a replacement, this slice.

## 2. Decisions log

- UI primitives ship as plain CSS-styled React components (no CSS-in-JS/Tailwind dependency added,
  consistent with the existing zero-framework styling approach) in
  `apps/companion/src/components/ui/`: Button, IconButton, Checkbox, Select, Input, SearchInput,
  Tabs, SectionHeader, SettingsGroup/SettingsRow, Badge, Slider, Tooltip. Existing bespoke settings
  panels (OBS, Companion Token, Hotkeys, Autostart) migrated onto them; further migration happens
  incrementally as other screens are touched, not as a big-bang rewrite.
- Router: still no client-side router library added — Heroes/Hero-detail is one more `Section`
  variant plus in-section state (selected hero id), consistent with how the app already models
  navigation. Introducing a router is not required for 2 extra screens and would be scope creep.
- Settings gains a "Чат и TTS" category (`ChatTtsSettings.tsx`) owning every permanent TTS/chat
  preference, reading/writing the SAME `useTwitchChatSession()` instance `AppShell` already owns —
  moved out of `TwitchChatPage`'s sidebar, which now shows only runtime state (messages, connection,
  skip/stop TTS actions) plus a link back into that Settings category.
- Sounds → "Герои" tab is now a redirect into the new Heroes section, not a second independent
  hero-ability UX — `HeroesGrid.tsx`/`HeroAbilitiesModal.tsx` were deleted (their real replacement is
  `HeroesPage.tsx`/`HeroDetailPage.tsx`, both reusing the exact same game-sound engine/commands
  `SoundsPage` already used).
- Local overlay renderer: a standalone Vite/React app at `apps/companion/overlay-renderer/`
  (separate `vite.overlay-renderer.config.ts`, own `tsconfig.json`), built to ONE self-contained
  HTML file via `vite-plugin-singlefile` and committed at
  `apps/companion/src-tauri/src/overlay_server/renderer-dist/index.html` (a compile-time dependency
  of `overlay_server.rs`'s `include_str!`, same pattern the file it replaced already used — wired
  into `pnpm build`/`beforeBuildCommand` so a real `tauri build` always regenerates it, but a plain
  `cargo check` also works without a prior frontend build). It fetches `/overlay/state` and
  subscribes to `/overlay/events` itself, ports the same 1920×1080 cover-fit virtual-canvas scaling
  apps/web's `OverlayCanvas` uses, and renders real local data — `LocalSessionSummary` (reused
  verbatim from `local_runtime::summary::get`, the same function the Home page's own panels call)
  and a `CurrentGameSnapshot` (hero id + KDA, parsed from GSI, hero name/icon resolved via the same
  `heroCatalog.ts` the rest of Companion uses) — for all 4 `BroadcastState`s. Verified end-to-end
  with a real headless-browser render (Playwright) of the built bundle against mocked snapshots.
  **Explicitly not attempted**: pixel-identical porting of apps/web's user-positionable widget
  layout (`OverlayLayout`/`xVw`/`yVh`/`scale`/`anchor` per widget) — the local server has no access
  to a user's saved layout yet (same underlying gap as favorites — see §1.5 — the endpoint is
  JWT-only). Fixed, sensible default positions are used instead. A future ticket could close this
  the same way favorites was closed here: a companion-token-authenticated read of
  `/account/me/overlay-layout`.
- OBS Browser Source migration: read path (`GetInputList`/`GetInputSettings`, filtered to
  `browser_source` inputs) classifies every candidate purely by URL shape — `127.0.0.1:3666` prefix
  = local, contains `/overlay/` = legacy (matches the real `siteUrl('/overlay/<publicToken>')` shape
  regardless of domain/environment, not hardcoded to `prereborn.ru`), anything else = not ours.
  Exactly one legacy candidate → migration offered (`SetInputSettings` with `overlay: true`, scoped
  to only that input's `url` field — structurally cannot reach scene-item transform/position/crop or
  any other source). Zero → "not found". More than one → "ambiguous", never auto-picked. Classification
  logic is pure and unit-tested independent of the OBS websocket transport (no mock server built —
  consistent with how this file's existing 25+ tests already test pure logic, not the live socket).
  Surfaced in Settings → OBS as a "Browser Source" panel with a manual "Проверить" action.
- Visual QA: performed via Playwright screenshots at 2560×1440/1920×1080/1366×768/960×640 across
  Home/Heroes/Hero detail/Chat/Sounds/Оформление/Settings (companion frontend, `vite` dev server,
  Tauri `invoke` calls fail outside a real Tauri webview so all data is in its documented
  loading/error state — layout/overflow/responsiveness is what was verified, not live data
  rendering) and of the 4 overlay renderer states with realistic mocked snapshots. Found and fixed
  one real issue: the hero detail page's ability panel inherited the video's 16:9-bound column
  width, wasting ~1100px on ultrawide.

## 3. Remaining / follow-up

- **Full pixel-parity overlay renderer** (user-positionable widget layout, minimap cover, draft
  protection full-cover art, anti-snipe layer) — needs the local server to read the user's saved
  `OverlayLayout` (currently JWT-only, same gap as favorites had) plus a genuine screenshot-diff
  pipeline against `apps/web`'s live overlay to verify parity honestly, not just claim it.
- **Companion Token → real desktop auth** — documented as a real, load-bearing gap in §1.3;
  replacing the copy/paste token with a device-code-style Companion login needs new auth surface in
  `apps/api`, out of scope for a UI-focused slice that was explicitly told not to break existing
  auth. Transitional UX (link to `/stream` → Companion) kept as-is.
- **RecentMatches overlay widget** — `LocalSessionSummary.recentMatches` is already served in the
  overlay snapshot but the renderer doesn't visualize it yet (only the current record + delta);
  small, bounded follow-up once the widget-layout gap above is addressed anyway.
- **Legacy server overlay deprecation decision** — not attempted this slice, per §1.6: it remains
  the only path for unmigrated Browser Sources, direct viewer/mod URLs, and the companion-offline
  draft-protection safety fallback. A real deprecation call needs to explicitly accept or replace
  that safety-fallback tradeoff first.
- **OBS Browser Source migration live-instance verification** — the classification/write logic is
  unit-tested against a pure function, but exercising it against a *real* OBS instance's websocket
  server end-to-end (not a mock) needs a live OBS install, which this environment doesn't have;
  flagged here rather than silently claimed as fully verified.
