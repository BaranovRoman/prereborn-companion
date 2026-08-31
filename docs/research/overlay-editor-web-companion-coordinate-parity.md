# Web ↔ Companion overlay coordinate parity

## Question
Why the local Companion/OBS renderer shrank or shifted saved overlay elements compared with the Web reference, and which old editor features still have real data/runtime support.

## Current state
Web and Companion both use a cover-fitted virtual scene and the same saved `OverlayLayout`. Companion embeds a standalone renderer at `/overlay`; the editor previews that exact URL in an iframe. Queue settings are backend-owned with a local cache, while GSI/session state is local-authoritative.

## Findings
- Web `computeSceneDimensions` uses persisted `aspectRatio.width` and `height`. Companion instead rebuilt height from `widthRatio/heightRatio` on a hard-coded 1920 width. Pixel geometry (`cameraZone`, minimap) and percentage widget geometry therefore stopped sharing the saved virtual canvas outside the 1920×1080 default.
- Both renderers already apply exactly one cover transform (`max(viewportWidth / sceneWidth, viewportHeight / sceneHeight)`, centered, top-left origin). The extra discrepancy was the Companion-only scene-dimension derivation, not OBS source transform mutation.
- OBS migration changes only the Browser Source URL. It cannot change scene-item transforms or the separate webcam source.
- Companion had stopped rendering the saved editor-only `cameraZone`; this made the camera reservation appear moved/missing, but did not move the physical OBS webcam.
- `AnchoredBox` scaled only its child. Its editor wrapper had no scaled width/height, so selection bounds and resize handles did not match the rendered widget.
- Draft incorrectly reused Gameplay HUD/minimap controls. The old Web renderer defines Draft protection independently (`off`/`cover`, atmospheric background, custom anchored text, bouncing logo).
- Web already contains collision-triggered logo hue changes; Companion had ported only the bounce.
- The old webcam field is a fallback still image. It has meaningful local semantics and is now managed as a local Companion asset.
- Rating goal is still present in the queue contract and renderer, so it remains meaningful. Current/start values must come from local session MMR, with only the target being user-configured.
- Twitch chat exists as a remote Companion page polling endpoint, but no local authoritative chat stream is exposed to the standalone loopback renderer. Followers/subscribers/donations likewise are not present in its cached account projection. Their dead controls must remain absent; social links continue to render because they are in queue settings.

## Options
- Add offsets/scales per widget: rejected because it would preserve two coordinate systems and break other output sizes.
- Force every output to 1920×1080: rejected because saved Web layouts support explicit virtual-canvas dimensions.
- Use the persisted canvas and the Web transform contract everywhere: selected; it fixes all scene elements together.

## Recommendation
Keep `aspectRatio.width/height` as the only virtual-canvas dimensions, use one cover transform in preview and OBS, retain camera as an editor-only guide, and expose controls only where the renderer and data source have observable behavior.

## Follow-up
Manual QA should compare the same preset in Web and Companion at 1920×1080 and 2560×1440, including camera bounds and widgets in multiple corners. A future Twitch/community restoration requires a deliberate local renderer data contract rather than exposing remote-only dead switches.

## Sources
- `apps/web/src/components/pages/overlay/overlay-canvas.tsx`
- `apps/web/src/entities/stream-overlay-layout/lib/scene-dimensions.ts`
- `apps/web/src/components/pages/stream/overlay-editor/camera-zone-editor.tsx`
- `apps/web/src/components/pages/overlay/full-cover/`
- `apps/web/src/components/pages/stream/settings/queue-widgets-panel.tsx`
- `apps/companion/overlay-renderer/`
- `apps/companion/src-tauri/src/obs.rs`
