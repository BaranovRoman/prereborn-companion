# Twitch Extension setup (WK-116)

The Between Matches quiz's viewer-interaction layer is a Twitch Video
Overlay Extension (`apps/twitch-extension`). Its code is complete and
tested, but **registering, uploading, and activating it on Twitch is a
manual step only the account owner can do** - the sections below are exactly
what's needed to do that, so it doesn't have to be rediscovered.

## What already works without this

Companion renders the shared quiz board and the backend runs the full round/
scoring lifecycle regardless of whether the Extension is ever registered -
per the locked architecture, Companion has no dependency on Extension
availability. Skipping everything below does not break Between Matches.

## 1. Register the extension

1. Twitch Developer Console → <https://dev.twitch.tv/console/extensions> →
   "Create Extension".
2. **Extension type**: Video Overlay.
3. **Name**: e.g. "PreReborn Quiz" (viewer-facing, shown in the Extensions
   directory).
4. Fill in the required listing fields (description, icons, category) -
   content details, not build-affecting.

This produces a **Client ID** - copy it, needed below.

## 2. Get the Extension secret

Console → your extension → **Settings → Secrets** → "New Secret". Twitch
shows the secret **once**, base64-encoded, in the exact shape
`TWITCH_EXTENSION_SECRET` below expects. Store it securely (password
manager / secrets vault) - it cannot be viewed again, only rotated (which
invalidates every previously-issued viewer JWT).

## 3. Configure the backend

Add to the production environment (`shared/.env`, via the `production`
GitHub Environment secrets that `deploy-production.yml` writes on every
deploy - see `docs/production-deployment.md`):

```
TWITCH_EXTENSION_CLIENT_ID=<Client ID from step 1>
TWITCH_EXTENSION_SECRET=<base64 secret from step 2>
```

Until these are set, `GET/POST /api/stream/extension/quiz/*` return `503
{"error":"twitch_extension_not_configured"}` - a deliberate, visible
"not configured yet" state, not a crash (see
`middleware/authenticate-twitch-extension.ts`).

No `CORS_ALLOWED_ORIGINS` change is needed - `config/cors.ts` already
allows any `https://<client_id>.ext-twitch.tv` origin by pattern (Twitch's
own hosting domain for every registered extension) plus the local Developer
Rig's fixed origin, so this works immediately once the extension is live,
without redeploying the backend again.

## 4. Build and upload the extension bundle

```
cd apps/twitch-extension
pnpm install
pnpm build
```

Produces `apps/twitch-extension/dist/index.html` - a single self-contained
file (JS/CSS inlined, ~4KB). In the Developer Console, under **Asset Hosting
→ Files**, upload this file as your **Viewer Path** for the version you're
testing/releasing. This extension has no Config or Mobile view for v1 - only
Viewer.

Rebuild and re-upload a new file whenever `apps/twitch-extension/src/`
changes; there is no CI/CD pipeline publishing this automatically (unlike
`apps/api`/`apps/web`/Companion - this genuinely is a manual upload step
each time, by Twitch's own extension-review model).

## 5. Local testing before going live

Twitch's **Developer Rig** (<https://github.com/twitchdev/developer-rig>)
lets you load the built `dist/index.html` against a real or simulated
channel without going through Twitch's review queue. Two useful query
params the extension itself supports for this (see `src/main.ts`):

- `?apiBase=http://127.0.0.1:3001/api` - point at a local `apps/api` dev
  server instead of production, so you can test against locally-seeded quiz
  rounds. (No live GSI/Companion needed to seed one - call
  `enterBetweenMatches` directly, same as this feature's own test suite
  does.)
- `?debugHitboxes=1` - renders the hitbox regions with a visible outline
  (semi-transparent red fill + border) instead of fully transparent, so
  alignment against Companion's real rendered buttons can be visually
  confirmed. Also updates the page `<title>` to `quiz: live` / `quiz: stale/
  offline` every second, reflecting `hitbox-logic.ts`'s fail-closed
  staleness check.

Test alignment at the same resolutions the rest of WK-116 was validated at:
1920×1080 and 2560×1440, plus whatever smaller desktop player size the Rig
defaults to - hitboxes are normalized 0..1 against the full video canvas
(see `src/geometry-contract.ts`), so they should track correctly at every
size Twitch's player actually renders the stream at.

## 6. Submit for review, then activate

Twitch reviews every extension before it can go live on a real channel
(separate from this repo's own CI). Once approved:

- Console → your extension → **Versions** → activate the reviewed version
  for your own channel (Config tab → "Install"), or release it to the
  Extensions directory if you want other broadcasters to be able to install
  it too (out of scope for v1 - built and tested for the owner's own
  channel only).

**Do not claim this feature is "live for viewers" until Twitch has actually
accepted and served the extension** - everything above this line is
prepared and ready, but the review/activation step happens entirely on
Twitch's side and cannot be automated or predicted from this repo.
