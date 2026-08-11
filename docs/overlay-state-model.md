# Overlay state model

The public overlay resolves exactly one scene for each complete polled payload.

Priority:

1. An explicit test override is applied immediately.
2. If Companion is offline or its server-side state is stale, the protected draft
   scene is used. When draft protection is explicitly disabled, the last complete
   GSI-derived scene remains selected because `off` is an explicit protection opt-out.
3. Otherwise the GSI-only resolver selects queue (`betweenMatches`), `draft`, or
   `gameplay`.

The polling hook never clears a valid payload after a network or 5xx error and never
runs overlapping requests. It preserves that payload while marking Companion offline,
so protected modes fail closed until a fresh response arrives. React therefore replaces a scene and its complete layout
in one render; it does not render an intermediate layout. Queue remains its existing
full-screen scene. Draft and gameplay keep independent layouts inside one versioned
configuration. Older single-layout settings migrate into gameplay; draft and new
protection settings receive safe defaults.

## Gameplay anti-snipe audit (WK-40)

The bounded audit confirmed two sensitive surfaces supported by product evidence:

- minimap, already protected by the existing minimap layer;
- buyback portrait borders, protected by configurable permanent neutral rectangles.

No other gameplay area was added. Session statistics, current hero, recent matches,
camera guides, and editor reference images do not disclose an additional confirmed
hidden gameplay state. Reference images and guides are preview-only.
