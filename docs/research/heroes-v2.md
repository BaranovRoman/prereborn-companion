# WK-132 — Heroes v2: roster/search + Hero Detail + ability sound assignment

## Why this is a targeted fix, not a redesign

The Heroes v2 task brief assumed the current Companion Heroes UI was still a generic
CRUD/dashboard surface needing a full rebuild toward Dota/PreReborn visual language. That
premise predates WK-121/WK-122/WK-125, which already did most of that work:

- Dota-style hero portrait grid (no rounded cards, idle grayscale/dim → hover brighten,
  `--radius: 1px` square geometry) — `HeroesPage.tsx`, `App.css` `.hero-portrait-tile`.
- Keyboard-driven search with no permanent input, RU/EN/alias matching, Escape/Backspace/3s
  auto-clear — `HeroesPage.tsx`.
- Hero Detail composed as hero visual + ability list, radial-masked video (not a "video player
  card"), tri-state ability rows with inline sound assignment (no modal) —
  `HeroDetailPage.tsx`.
- Tri-state ability support (`supported`/`experimental`/`unsupported`) sourced from the
  generated GSI catalog, already gating bindability correctly.

Per the task's own instruction ("не начинай с редизайна… сначала исследуй"), this slice audits
what's actually there against the old Web implementation's *actual* production behavior and
fixes only the concrete gaps found.

## Old Web vs. current Companion (audit findings)

The task brief assumed `apps/web` had a Heroes roster/search/detail page. It doesn't — the
comparable old implementation is the **Favorite Heroes picker**
(`apps/web/src/components/pages/stream/settings/queue-widgets-panel.tsx`), used to pick up to 3
heroes for the "Между матчами" overlay. Its search UX went through several iterations; only the
*final, settled* version is the meaningful comparison point (git history:
`5464c35` → `b7d99a9` → `76714b2` → `4d43cce` → `73832d7`).

| Aspect | Old Web (final/settled) | Companion before this slice | Companion after this slice |
|---|---|---|---|
| Unmatched heroes | Dimmed in place (`opacity: .58; grayscale(.72) brightness(.72)`), never unmounted | **Filtered out of the DOM** — removed from the grid entirely | Dimmed in place (`opacity: .3; grayscale(1) brightness(.5)`), never unmounted |
| Grid geometry while typing | Stable — all tiles stay mounted, no reflow | Reflowed — attribute columns shrank/disappeared as matches dropped out | Stable — full roster always renders |
| Match highlight | Warm red-orange border + glow | None (non-matches just vanished) | Gold border + glow (existing "identity" accent token, distinct from hover's red-hover) |
| Query display | No input field; giant centered overlay of the typed query | No input field; small sticky chip | No input field; small sticky chip (kept — a full-bleed overlay fit a modal picker, not a primary nav page) |
| Keyboard model | `window` keydown, Backspace edits, letters append, 3s idle auto-clear | Same (already ported in WK-122) | Unchanged |
| Escape | Not specially handled (falls through to modal close) | Clears query immediately | Unchanged (Companion isn't a modal, so immediate-clear is the correct analogue) |
| Case/alias matching | `toLocaleLowerCase()` + `ё`→`е` normalize, RU/EN internal-name + full alias table | Same (`searchHeroes()` in `heroCatalog.ts`, already ported) | Unchanged |
| Transitions | 140ms ease on transform/border/filter/opacity/box-shadow | Same treatment already present on `.hero-portrait-tile` | Unchanged |

**Key finding**: web's *original* implementation (`5464c35`) also filtered/hid unmatched heroes
— that's what Companion's WK-122 slice ported. But a later Web commit
(`b7d99a9`, message: "streamline widget configuration") deliberately replaced that with
dim-in-place, and a follow-up (`73832d7`, message: "keep heroes visible during search") tuned
the dim lighter specifically because heroes disappearing/reflowing during search was bad UX.
Companion's WK-122 slice ported web's *original*, since-abandoned behavior rather than its
*settled* one — this is the actual regression behind "old Web search was better".

## What changed in this slice

1. **`HeroesPage.tsx` / `App.css`** — search no longer filters `DOTA_HEROES`; the full grouped
   roster always renders. Each tile gets `data-search-match="true|false"` (via
   `searchHeroes(query)` as a matched-id set, not a filter predicate); CSS dims non-matches and
   gold-highlights matches. The "not found" case no longer replaces the grid with a message — it
   stays visible (fully dimmed) with a small inline hint next to the query chip.
2. **`HeroDetailPage.tsx`** — added a non-blocking hint when `GameSoundSettings.enabled ===
   false` ("Звуковые реакции выключены глобально…"), directly under the Способности heading.
   Assignment/preview/remove all remain fully usable — this only affects live in-match playback,
   consistent with how `enabled` already gates in `game_sounds/mod.rs`. No new global toggle was
   added; the real one stays in Sounds.
3. **`HeroDetailPage.tsx` / `AppShell.tsx`** — a preview started on this page is now stopped on
   unmount (`useEffect(() => stopPreview, [stopPreview])`), not just before choosing a new file.
   Covers both the back button and switching to another nav section while a preview is playing.

## Canonical data sources (unchanged)

- Hero roster/aliases: `apps/companion/src/services/heroCatalog.ts` (static, ported from
  `apps/web`'s hero model).
- Ability catalog + tri-state support: `apps/companion/src-tauri/src/game_sounds/
  generated_hero_catalog.json`, generated by `scripts/generate-game-sounds-hero-catalog.mjs`
  from pinned `odota/dotaconstants`. Not regenerated or altered by this slice.
- Sound assignment storage: `<app_data_dir>/game-sounds-config.json` (`schemaVersion: 1`),
  managed sound files under `<app_data_dir>/sounds/`. Not touched — no schema/key changes, so
  existing user assignments keep working unmodified.

## Sound assignment reuse

`SoundBindingRow` (`components/sounds/SoundBindingRow.tsx`) is unchanged and continues to be
shared verbatim between Items (`kind: "itemUsed"`) and hero abilities (`kind: "abilityCast"`),
both against the same `useGameSoundEngine` instance owned by `AppShell`.

## Support-state semantics (confirmed, unchanged)

`AbilityStatus = "supported" | "experimental" | "unsupported"` (Rust `catalog.rs` /
TS `dotaCompanionApi.ts`), baked into the generated catalog. Both `supported` and `experimental`
remain bindable; only `unsupported` disables the row — this logic was already correct and
untouched by this slice.

## Compatibility

- No storage key, schema version, or ability-id representation changed. Existing
  `game-sounds-config.json` files load and bind exactly as before.
- No Rust/Tauri command signatures changed.

## Techies regression check

Verified against the real generated catalog entry (`generated_hero_catalog.json`,
`npc_dota_hero_techies`): 7 abilities — 5 `supported` (Sticky Bomb, Reactive Tazer, **Blast
Off!**, Proximity Mines, plus Reactive Tazer's toggle alias), 1 `unsupported` (M.A.D. — no cast
moment), 2 `experimental` (Minefield Sign, Detonate M.A.D.). Added as a regression test in
`HeroDetailPage.test.tsx` using this exact data, asserting each renders with the correct
disabled/enabled state.

## Screenshots

Captured against the real `HeroesPage`/`HeroDetailPage` components via the Vite dev server
(`localhost:1420`) with `window.__TAURI_INTERNALS__.invoke` mocked to return realistic
`GameSoundCatalog`/`GameSoundSettings` fixtures (real Techies/Pudge ability data pulled from
`generated_hero_catalog.json`) — the actual Tauri shell can't launch headlessly in this
environment. Saved under `docs/qa-screenshots/` (gitignored, local review only):

- `wk132-A-roster-no-search.png` — roster, no search.
- `wk132-B-roster-active-search.png` — roster mid-search ("pud"): non-matches dimmed in place,
  grid geometry unchanged from A.
- `wk132-C-techies-detail.png` — Techies detail: all 7 abilities, M.A.D. disabled/grayed,
  Minefield Sign + Detonate M.A.D. flagged experimental.
- `wk132-D-hero-detail-assigned-sound-pudge.png` / `wk132-D2-*-expanded.png` — Pudge detail with
  Meat Hook bound to `hook-scream.wav`, expanded to show the inline `SoundBindingRow`.
- `wk132-G-sounds-globally-disabled-hint.png` — Pudge detail with `settings.enabled = false`:
  hint banner shown, ability list still fully interactive.
- `wk132-F-roster-small-window.png` / `wk132-F2-detail-small-window.png` — 1024×720: attribute
  grid drops to 2 columns (existing breakpoint), Hero Detail composition holds up. Note: the top
  nav bar clips at this width ("ЗВУКИ" partially cut off) — pre-existing (frozen Header v9, out
  of this slice's scope per the task's own instruction not to touch it).

Hero portrait/video images are Steam CDN URLs; some screenshots show them unloaded (sandboxed
environment network access) — this is a capture-environment artifact, not a code issue.

## Scope not touched

Detector/Rust ability-classification logic, item sound assignment, global audio settings UI,
hero/ability catalog generation, navigation architecture (still local React state, no router),
hero visual/video composition, and the existing HUD ability-row/sound-binding-row visual
language — all were already in line with the task's stated direction and are left as-is.
