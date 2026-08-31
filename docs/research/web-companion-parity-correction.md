# Web to Companion broadcast parity correction

## Question

Which production web broadcast controls were lost in the local-first Companion migration, and which P0/P1 capabilities should be restored without creating separate preview/runtime implementations or duplicate persistence models?

## Current state

The localhost overlay is the authoritative OBS renderer and the Companion Design page embeds that same renderer. The old production UI and configuration remain in `apps/web`; the current renderer already understands the full overlay-layout schema, but the Companion editor exposes only a narrowed subset. Between Matches regained the old visual composition in 0.5.51, while its account-backed queue settings were not carried over.

## Findings

| Old web feature | Current Companion before this correction | Action |
| --- | --- | --- |
| Idle current MMR and session-start snapshot | MMR command required an open OBS session | P0: persist one current-rating seed locally, allow idle correction, snapshot it into the next session |
| Backend last-known MMR | Account refresh returns game mode only | P1: hydrate only when local rating is unknown; never overwrite a local correction |
| Favorite heroes grouped by attribute, alphabetized, wide art, max 3 | Same catalog and max 3, but catalog order and square presentation | P1: restore deterministic localized-name ordering and landscape cards |
| Between channel/profile, webcam, favorite heroes, recent games, social/community and visibility settings | Renderer has a fixed composition; Design page says there are no settings | P0: reuse the existing account queue-settings row/API and cache it for the local renderer |
| Between atmospheric scene | Restored tree/fog/ember production assets in 0.5.51 | Keep and regression-test; no redesign |
| Draft protection mode, custom text, anchors, position and scale | Runtime schema/layer supports mode and text, editor exposes none | P0: expose controls and edit the real iframe-rendered element through a preview bridge |
| Draft atmosphere | Protection layer contains an atmosphere layer; ordinary draft background is sparse | P1: use the shared production atmospheric layers without restoring removed draft modes |
| Gameplay session/current-game/recent widgets | Runtime supports all three; editor types/UI expose only two | P0: restore visibility, anchor, scale and X/Y for all three |
| Gameplay minimap cover presets, corner, position and size | Runtime supports saved settings; editor exposes none | P0: restore the existing settings in the editor |
| Camera-zone guide | Old editor-only OBS alignment aid, not broadcast output | P2: document only; it is not required for runtime parity |
| Companion-status widget | Hidden legacy editor widget | No action |
| PostStream summary | Fixed local summary; old layout schema had no separate post-stream widget layout | No P0/P1 change; retain shared BroadcastState and verify |

Confirmed architecture: visual layout is already stored through the existing overlay-layout service; Between content belongs to the existing backend queue-settings entity; realtime session and match data stays in the local runtime. No new backend entity or second hero/rating catalog is required.

## Options

1. Reimplement old settings as Companion-only objects. This is quick but duplicates authoritative account data and violates parity.
2. Reuse overlay layout for visual state and the existing queue-settings row for account/shared Between state, caching both in the local server. This preserves old semantics and offline rendering after refresh.
3. Keep fixed renderer composition and only add labels in the editor. This does not restore functionality.

## Recommendation

Use option 2. Keep one resolved local broadcast snapshot plus the two existing configuration domains: local visual layout and account queue settings. The Design iframe and OBS URL must continue to render the same React scene; editor-only interaction is a message bridge that overrides/commits the same layout rather than a second preview component.

## Follow-up

Implement the P0/P1 actions above, then validate at 1920×1080 and 2560×1440. Separately investigate the existing production-log finding that a real GSI session logged session lifecycle but no `match_finalized` or rating transition; that broader match lifecycle audit is outside this parity slice.

## Sources

Repository sources only: old web overlay editor and queue settings under `apps/web/src/components/pages/stream`, current Companion editor/renderer under `apps/companion`, and the existing queue-settings/session services under `apps/api`.
