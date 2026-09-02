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

## Scope not touched (WK-132)

Detector/Rust ability-classification logic, item sound assignment, global audio settings UI,
hero/ability catalog generation, navigation architecture (still local React state, no router).

---

# WK-133 — Hero Detail visual/product revision

First-round Hero Detail screenshots (WK-132) went to visual review. Verdict: search dim-in-place
approved and locked (no further changes); Hero Detail rejected — the vertical ability-row list
(icon + name + status text, one `SoundBindingRow` per click) still read as a settings form, and
the hero visual was too small/timid. Revised direction: a Dota hero-pick-screen composition —
large hero visual as the scene's own background, name + a horizontal ability **icon** strip
anchored top-left, no permanent per-ability text, tooltip on hover/focus, one expanded
sound-control panel below the strip on click.

## What changed

`HeroDetailPage.tsx` rebuilt (`App.css`'s `.hero-detail*`/`.hero-ability-row*` block replaced by
`.hero-detail__scene`/`.hero-ability-icon*`/`.hero-ability-expanded*`):

1. **Hero visual** — a large (`min(72vh, 820px)` square) radial-masked background biased to the
   right of the scene, feathered into the app's existing ambient fog/ember layer (no visible
   rectangular container). Kept **square**, matching the source video's actual aspect (the old
   code's own comment: "production hero-idle-loop capture is always 1:1") — an earlier pass tried
   stretching it to `inset:0` on the wide scene rectangle, which forced a much heavier crop than
   the video's framing was designed for and produced an unrecognizable close-up on a more dynamic
   loop (Pudge's hook swing). Same failure mode would hit any hero whose idle loop isn't a
   static-ish pose like Techies'.
2. **Identity** — hero name + favorite + attribute badge moved to the content block's top-left,
   anchored above the ability strip (no longer floating top-right).
3. **Abilities** — `AbilityStrip` replaces `AbilityList`: each ability is a 56×56 icon button
   only (no name/status text at rest), `flex-wrap`ped, tri-state conveyed via
   opacity/grayscale/dashed-outline/a small "?" corner marker + a gold bound-dot — not a card
   background. Verified on Invoker (14 abilities, all experimental) that it wraps onto 2 rows
   correctly with no special-cased layout.
4. **Tooltip** — name/status/assigned-filename on hover/focus, reusing the existing
   `.ui-tooltip__bubble` CSS recipe directly on the ability button (not `Tooltip.tsx`'s wrapper
   span) so a dense kit doesn't get a second empty tab stop per ability. Bubble opens **downward**
   (`.hero-ability-icon .ui-tooltip__bubble { top: ...; bottom: auto; }`) — opening upward (the
   shared default) collided with the hero name directly above the strip.
5. **Expanded control** — clicking a bindable ability shows one `.hero-ability-expanded` panel
   below the strip with the ability name + the same `SoundBindingRow` (stripped of its own
   border/background so it doesn't nest a card inside a card); selecting another ability swaps it,
   clicking the same one again or pressing Escape collapses it. Still exactly one at a time — same
   underlying `selectedAbilityId` state as before, just relocated.
6. **Globally-disabled hint** — now a single muted line near the strip ("Звуковые реакции
   выключены"), not the earlier detached full-width bordered box.
7. **Media failure** — if the video errors, falls back to the portrait image; if that also
   errors, the visual container just doesn't render (name/abilities stay anchored normally, no
   empty bordered rectangle).

A real accessibility bug surfaced and got fixed while wiring this up: the ability buttons had
`role="listitem"` (copied from `HeroesPage`'s portrait-tile pattern), which overrides a
`<button>`'s implicit `button` role — breaking `getByRole("button")` queries and, for real screen
readers, the announced control type. Dropped the list/listitem roles on the strip; these are
plain buttons, not a semantic list.

## Not changed / explicitly out of scope for WK-133

Search/roster (approved, locked per instruction), sound assignment storage/validation/preview
architecture, detector semantics, item sounds, OpenDota/statistics integration (the composition
leaves the scene's right side open for a future stats block, per instruction, but nothing is
implemented or stubbed there).

## Screenshots (round 3, final — WK-133)

Same mocked-Tauri dev-server approach as WK-132, extended with real Invoker ability data (14
abilities, all `experimental`, from `generated_hero_catalog.json`). Saved under
`docs/qa-screenshots/wk133-*.png`. Two issues surfaced and were fixed across three capture
passes (the earlier `.hero-detail__visual-bg`'s `inset:0`/biased-crop version and the two rounds
before this are superseded — history kept here for the record, not as separate artifacts):

1. **Video-crop bug (round 1)** — the visual was stretched via `object-fit: cover` +
   `inset: 0` + a biased `object-position` across the whole (non-square) scene rectangle. The
   source hero-idle-loop videos are square (1:1, per the pre-WK-133 code's own comment); this
   forced a much heavier crop than the video was framed for, producing an unrecognizable
   close-up on a more dynamic loop (Pudge's hook swing). **Fix**: kept `.hero-detail__visual-bg`
   itself square (`min(72vh, 820px)`, biased to the scene's right edge) so `object-fit: cover`
   stays centered with minimal cropping while still reading as large. Confirmed via a headless
   DOM probe that the video paints correctly once given time to reach a real frame
   (`readyState: 4`, no `video.error`).
2. **Header disappearing at 1024×720 (rounds 1–2)** — root cause: `.hero-detail__scene`'s
   `min-height: min(74vh, 760px)` was tall enough, combined with page chrome, to exceed a
   720px-tall viewport; `.main`'s `flex: 1; overflow-y: auto` doesn't actually constrain itself
   without `min-height: 0` (a real, pre-existing latent bug in the shared shell CSS, not
   introduced by this slice — fixed as a small, universally-safe addition), but that alone
   wasn't sufficient because `.app-shell` itself only sets `min-height: 100vh` (a floor, not a
   fixed height), so `.main`'s flex-basis calculation still isn't hard-capped at the viewport.
   Rather than touch the shared shell's height architecture (out of this slice's scope, and
   risky across every `.main`-hosted page), added a **height-based** breakpoint
   (`@media (max-height: 820px)`) that shrinks the scene enough to fit short windows regardless
   of width — the existing `@media (max-width: 900px)` breakpoint alone didn't catch this case
   since 1024px is wider than that threshold. Verified via a headless DOM probe post-fix:
   `header.getBoundingClientRect().top === 0`, `document.body.scrollHeight === window.innerHeight`
   (720px, no page-level overflow at all) at 1024×720.

- `wk133-01/03/05-*-resting.png` — Techies/Pudge/Invoker, nothing expanded. Large, well-framed
  full-body hero art; Invoker's 14 abilities wrap onto 2 rows (10 + 4) with no vertical-list
  fallback.
- `wk133-02-techies-expanded.png` / `wk133-04-pudge-assigned-expanded.png` — Sticky Bomb (no
  sound) and Meat Hook (`hook-scream.wav`) expanded panels below the strip; tooltip bubble opens
  downward, doesn't overlap the hero name.
- `wk133-07-sounds-disabled.png` — compact inline hint, strip stays interactive.
- `wk133-08-small-window.png` — 1024×720, header stays pinned, no page-level scroll, hero scales
  down via the height breakpoint.
- `wk133-09-media-unavailable.png` — Techies media requests blocked (`page.route` abort in the
  capture script); name/strip stay anchored, no empty bordered box. Note: there's no visible
  "media unavailable" messaging for the user in this state (it just quietly omits the visual) —
  matches the task's own instruction ("не превращать каждый edge case в modal") but is worth a
  product opinion on whether a small unobtrusive fallback treatment (vs. nothing) reads better.

All three rounds' screenshots were reviewed for regressions via fresh-context subagents (to work
around a same-session image-read budget limit encountered mid-review) in addition to direct DOM
verification for the two fixes above.
