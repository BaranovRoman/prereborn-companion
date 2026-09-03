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

---

# WK-140 — Hero Detail v2: centered hero + local statistics

WK-133's composition anchored everything (visual + content) top-left/right-biased, deliberately
leaving the right side open "for a future statistics block." This slice is that block, plus
re-centering the hero itself as the screen's dominant focal point.

## What changed

1. **Three compositional zones, not three panels** — `HeroDetailPage.tsx`'s JSX gained a
   `.hero-detail__grid` (a two-column flex row: `.hero-detail__left` / `.hero-detail__right`)
   layered over the still-absolutely-positioned hero visual, replacing WK-133's single
   `.hero-detail__content` block. No card/panel background was added to either column — the hero
   shows through the gap between them.
2. **Hero — centered and larger** — `.hero-detail__visual-bg` moved from `right: 0` (edge-biased)
   to `left: 50%; transform: translateX(-50%)` (centered), and grew from `min(72vh, 820px)` to
   `min(84vh, 980px)`. Kept square (source captures are 1:1 — see WK-133's crop-bug note, still
   applicable) and radial-masked/blended exactly as before.
3. **Back navigation relocated** — `← Герои` moved from a lone top-level grid row (which read as a
   button floating centered above the hero, per this task's own framing) into
   `.hero-detail__left`'s first child, restyled as a restrained breadcrumb (small, muted, no
   border/button chrome) rather than a `ui-button--ghost`.
4. **Local statistics (RIGHT zone)** — new `HeroStatsPanel` in `HeroDetailPage.tsx`, backed by a
   new `useHeroLocalStats(heroId)` hook (`hooks/useHeroLocalStats.ts`) → `getHeroLocalStats`
   (`services/dotaCompanionApi.ts`) → Tauri command `get_hero_local_stats`
   (`commands.rs`) → `local_runtime::summary::hero_stats` → `local_runtime::store::hero_local_stats`.

## Local stats — data source and audit

Audited `local_runtime::summary::LocalSessionSummary` (the Главная page's existing data) first,
per the task's explicit instruction not to duplicate stored match data. It's the wrong shape for
this: `recentMatches` is capped at 10 (`RECENT_MATCHES_DISPLAY`) for the Главная feed, and
`wins`/`losses` are session-scoped, not "this hero, across all local history." Rather than load an
unbounded match history into React to derive four numbers client-side, added one small dedicated
SQL aggregate — `store::hero_local_stats(conn, hero_id, recent_limit)` — mirroring the existing
`session_match_tally`/`list_recent_finalized_matches` query style (device-wide, `state =
'finalized'`, no new table/schema).

Returned fields: `matches`, `wins`, `losses` (COUNT queries), `avgKills`/`avgDeaths`/`avgAssists`
(SQL `AVG(...)`, `None` when there's no data — SQLite's own `NULL` semantics, not a fabricated
zero), `recentResults` (newest-first, capped at 10). Winrate itself isn't backend-computed — the
frontend derives it as `wins / (wins + losses)`, so an all-`abandon` hero (matches > 0, no decided
result) shows an honest "—" instead of a misleading `0%`; `matches` still counts abandons (an
observed match), keeping "matches played" and "decided results" distinguishable at the display
layer. Covered by three new Rust tests in `store.rs` (aggregate correctness across multiple
heroes/sessions, clean empty state, abandon-only history).

**Deliberately not implemented**: MMR gained/lost per hero. `detected_rating_delta` is immutable
but `rating_delta_correction` layers on top of it (WK-115's Dashboard correction feature) and only
counts when the match's *current* `ranked_mode` — not `ranked_mode_detected` — is Ranked; getting
that aggregation right would mean re-deriving `correct_match_ranked_mode`'s contribution rules a
second time in a read path, which is a real edge to get subtly wrong that the task's own "only add
if correctly and unambiguously derivable" instruction argues against including here. Matches/wins/
losses/winrate, average K/D/A, and the recent-results sequence ship; MMR-per-hero is left for a
follow-up if wanted.

## Semantics (explicit, per task requirement)

`HeroStatsPanel` always renders a closing caption line — "Локальная история Companion" — so the
numbers are never mistaken for lifetime Dota/OpenDota stats. `HeroLocalStats` (frontend type) /
`HeroLocalStats` (Rust DTO) is a standalone data boundary: `HeroDetailPage` passes only the DTO
into `HeroStatsPanel`, not the fetching hook, so a future OpenDota-backed source (WK-133 backlog,
explicitly out of scope here) can hand the same component richer data later without another Hero
Detail layout pass.

## Empty state

`stats.matches === 0` renders one quiet line — "Пока нет матчей в локальной истории" — no
zeroed-out KPI row, no bordered empty-state card.

## Responsive (1024×720 and narrow widths)

Reused WK-133's `@media (max-height: 820px)` breakpoint (still the one that actually catches
1024×720 — see that section's own note on why a width-only breakpoint misses this case) and added
an equivalent `@media (max-width: 1200px)` tier; both shrink the hero visual and cap
`.hero-detail__left`/`.hero-detail__right` width rather than stacking the three zones, per this
task's "composition over rigid columns" guidance. Below 900px width the grid wraps and the stats
column switches to left-aligned text (its `text-align: right` at normal widths is a wide-desktop
affordance, not load-bearing).

## Tests

`HeroDetailPage.test.tsx` gained a `describe("local statistics")` block (empty state, computed
matches/wins/losses/winrate against the task's own worked example — 24/15/9/62.5% — abandon-only
"no fabricated winrate," conditional K/D/A row, the local-history caption) plus a
`vi.mock("../services/dotaCompanionApi")` (jsdom has no real Tauri IPC). `AppShell.test.tsx` needed
a matching `useHeroLocalStats` mock alongside its other polling/IPC-backed hook mocks, for the same
reason. All existing ability-strip/sound-assignment/tri-state/tooltip/media-failure tests pass
unmodified — that interaction model was frozen per the task and genuinely untouched.

---

# WK-141 — Heroes Search v2: Reaver overlay query

WK-132's dim-in-place search *mechanics* were approved and explicitly frozen; only the query's
*presentation* was in scope here.

## What changed

`HeroesPage.tsx`'s `.hero-search-indicator` (a `position: sticky`, bordered/red-gradient-filled
chip — visually a form input, and one that occupied real flow space once it mounted, nudging the
grid down on the first keystroke) is replaced by `.hero-search-overlay`: `position: absolute;
inset: 0;` against a new `.hero-roster` wrapper (scoped to just the grid, so the overlay never
covers the section header/favorites row above it), `pointer-events: none` so it never blocks
clicking a tile underneath, no background/border/fill at all. The query itself renders in the
existing Reaver font (`var(--font-title)`, already wired app-wide since WK-134 — no new asset),
uppercase, sized with `clamp(2.2rem, 8vw, 6rem)` (a smaller `max-height: 820px` tier for short
windows), `overflow-wrap: break-word` so the 32-character input cap (pre-existing, `HeroesPage.tsx`
line ~89) can't force horizontal overflow.

Because the overlay is `position: absolute` (removed from flow) rather than the old `sticky` chip,
idle and active-search roster geometry are now byte-for-byte identical — mounting/unmounting the
overlay can't nudge `.attribute-grid` regardless of query length or match count.

Search mechanics untouched: `searchHeroes`, `matchedIds`, `data-search-match`/`data-searching`
dimming, keyboard capture (letters/Backspace/Escape/3s idle-clear), favorites, hero ordering — none
of that code moved.

## Tests

Added two presentation-only assertions to `HeroesPage.test.tsx`: the overlay only exists while a
query is active and no `.hero-search-indicator` element exists at all anymore (old vs. new class
names, not a pixel comparison), and that `.attribute-grid`'s parent element is unchanged before vs.
during an active search (a structural proxy for "no reflow," without asserting on computed
layout/pixels). All existing dim-in-place/matching/Escape/Backspace/favorite tests pass unmodified.

## Screenshots (WK-140 + WK-141 combined visual QA)

Pending capture against the mocked-Tauri dev-server approach WK-132–134 used (real Tauri can't
launch headlessly here) — will cover both tasks' required scenarios (Techies/Pudge/no-history/
Invoker/1024×720 for Hero Detail; idle/`"TEC"`/multi-match/no-match/1024×720 for Heroes search) in
one visual-review pass, saved under `docs/qa-screenshots/wk140-*.png` / `wk141-*.png`.

---

# WK-134 — Hero Detail narrow polish pass

WK-133's composition was approved in principle. This is a narrow, non-redesign polish pass on
four specific items — the ability strip's spacing/icon size/layout/wrapping/composition was
explicitly frozen and not touched.

## What changed

1. **Hero name typography** — `.hero-detail__identity h2` now uses the project's existing
   "Reaver" title font (`--font-title`). Companion didn't have this font wired in before (only
   `apps/web`'s `globals.css` declared it); added the identical `@font-face` (same family name,
   same Dota CDN URLs, same two weights) to `App.css` — not a new font asset, just extending the
   existing brand font to an app that doesn't share a stylesheet with `apps/web`. `font-weight`
   set to `600` (the real SemiBold face) instead of a synthesized `700`.
2. **Tooltip viewport-edge collision** — `AbilityStrip`'s icons gained an `onMouseEnter`/`onFocus`
   handler (`positionTooltip` in `HeroDetailPage.tsx`) that measures `getBoundingClientRect()`
   and sets `data-tooltip-align="start"|"end"` when the icon is within 132px of the left/right
   viewport edge; CSS reads that attribute to anchor the bubble's left or right edge to the icon
   instead of centering it. Pure CSS couldn't do this — `flex-wrap` means which icons actually sit
   near an edge isn't knowable ahead of time. Verified via a unit test with a mocked
   `getBoundingClientRect` (three cases: near-left, near-right, and centered/no override) and via
   screenshots at real edge positions.
   - **Bug found and fixed along the way**: a first-row icon's downward-opening tooltip on a
     *wrapped* strip (Invoker: 2 rows) rendered behind the second row of icons — later DOM
     siblings at the same stacking level paint on top regardless of the bubble's own `z-index`,
     since that only resolves *within* the hovered icon's own stacking context. Fixed by
     promoting the hovered/focused icon's own `z-index` above its siblings
     (`.hero-ability-icon:hover, .hero-ability-icon:focus-within { z-index: 2; }`) — applies to
     every row, not just the first.
3. **Ability icon image failure** — `AbilityIconImage` (new small subcomponent, one `useState`
   per icon so each can fail independently) swaps to `.hero-ability-icon__img-fallback` on
   `onError`: a quiet radial-gradient tile with a small centered dot, same dimensions, no text,
   no browser broken-image glyph. The tri-state styling (opacity/grayscale/dashed border) lives
   entirely on the parent `<button>`, so it's unaffected by whether the icon image itself loaded.
4. **Sound editor "belongs to the selected ability"** — smallest possible touch:
   `.hero-ability-expanded` got a 2px gold top border matching the selected icon's own gold ring
   color, instead of any positional caret/arrow (which would need per-icon JS position tracking
   across a wrapping strip — judged not necessary given the panel already appears immediately
   below the strip with the ability's own name as its header line).

## Not changed (explicitly frozen this pass)

Ability strip spacing/icon size/layout/wrapping/composition, hero visual size/positioning/
masking, sounds-globally-disabled treatment, search/roster behavior, sound assignment
architecture, detector semantics.

## Verification

366/366 tests pass (3 new: image-fallback rendering, tooltip start/end/center alignment via
mocked `getBoundingClientRect`), typecheck/build clean, `git diff --check` clean. Screenshots
(`docs/qa-screenshots/wk134-*.png`) covering all 11 requested scenarios plus two supplementary
captures (`10b`/`11b`) added specifically to visually confirm the z-index fix on Invoker's
wrapped strip and a genuine right-edge tooltip case (the originally-requested 1680px-wide
"last ability" capture never actually reached the true window edge, since content is
deliberately anchored top-left with the right side left open — `11b` uses a narrower window
purely to force a real edge case; the unit test is the actual correctness proof, independent of
window width). Reviewed via fresh-context subagents against a checklist per item (font
distinctness vs. surrounding UI text, no clipped/hidden tooltip text, no broken-image glyph, no
empty bordered box on hero-media failure, header/no-scroll regression at 1024×720) — all
confirmed, two real bugs found and fixed (tooltip z-index stacking; the alignment threshold
itself was correct on the first attempt).
