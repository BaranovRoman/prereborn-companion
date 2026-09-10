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

## 4. Build the extension bundle

```
cd apps/twitch-extension
pnpm install
pnpm build
```

Produces `apps/twitch-extension/dist/index.html` - a single self-contained
file (JS/CSS inlined, ~4KB, no Config or Mobile view for v1, only Viewer).

Rebuild whenever `apps/twitch-extension/src/` changes; there is no CI/CD
pipeline publishing this automatically (unlike `apps/api`/`apps/web`/
Companion - every version is a manual upload, by Twitch's own
extension-review model).

## 5. Extension version lifecycle (current model, 2026)

**The Developer Rig is deprecated** (Twitch [ended its
support](https://discuss.dev.twitch.com/t/end-of-support-for-the-twitch-developer-rig/42995)
in 2023) - the steps below use the Developer Console directly, which is now
the primary/only supported path. Every extension version moves through
four states, in order, each gated in the Console:

**Local Test → Hosted Test → Review → Released**

- **Local Test** (starting state for every new version): assets are served
  from a **Testing Base URI** you point at your own machine, not Twitch's
  CDN. Visible only to accounts you've explicitly added as testers (plus
  Twitch staff).
- **Hosted Test**: your built assets are uploaded to Twitch's own CDN as a
  ZIP and served from there instead - proves the extension still works
  once Twitch is hosting it, before anyone else can see it. Same
  tester-only visibility as Local Test. You cannot edit extension details
  again without dropping back to Local Test.
- **Review**: submitted for Twitch's own manual review (separate from this
  repo's CI). Only one version can be in review at a time.
- **Released**: live, immutable. Only one version is ever "Released" at a
  time; the previous one becomes "Deprecated".

### 5a. Local Test

1. Serve the built file over HTTPS from your own machine - Twitch's page is
   HTTPS, so an HTTP iframe would be blocked as mixed content. The
   simplest option is `http-server`'s built-in self-signed cert:
   ```
   npx http-server apps/twitch-extension/dist -S -p 8443
   ```
   Open `https://127.0.0.1:8443/` once in your own browser first and accept
   the self-signed certificate warning - Twitch's page can't click through
   that prompt for you inside the iframe.
2. Developer Console → your extension → **Asset Hosting** tab → set
   **Testing Base URI** to `https://127.0.0.1:8443/` (trailing slash
   matters).
3. Console → **Status** page → **"View on Twitch and Install"** → the
   purple **Install** button → pick your own channel. This mounts the
   extension for real on your actual channel page, reading straight from
   your local server - no Rig, no simulator.
4. Go to your channel (twitch.tv/<you>) to see it live under/over the
   player.

Use `?apiBase=http://127.0.0.1:3001/api` (point at a local `apps/api` dev
server instead of production, so you can test against locally-seeded quiz
rounds - no live GSI/Companion needed, call `enterBetweenMatches` directly,
same as this feature's own test suite does) and `?debugHitboxes=1`
(semi-transparent red fill + border instead of fully transparent, and the
page `<title>` ticks `quiz: live` / `quiz: stale/offline` every second per
`hitbox-logic.ts`'s staleness check) as query params on the Testing Base
URI while iterating - these are this extension's own dev affordances (see
`src/main.ts`), not a Twitch mechanism. Drop both once you're confident in
alignment, before moving to Hosted Test.

Test alignment at 1920×1080 and 2560×1440 (the resolutions the rest of
WK-116 was validated at) plus whatever smaller desktop player size you
normally stream at - hitboxes are normalized 0..1 against the full video
canvas (see `src/geometry-contract.ts`), so they should track correctly at
every size Twitch's player actually renders the stream at.

### 5b. Hosted Test

1. Zip the contents of `dist/` so `index.html` sits at the **root** of the
   zip (not inside a `dist/` folder inside the zip - Twitch rejects that
   layout):
   ```
   cd apps/twitch-extension/dist && zip -j ../twitch-extension-viewer.zip index.html
   ```
2. Console → your extension → **Files** tab → **Upload Version** → choose
   that zip → the purple **Upload** button.
3. Console → **Monetization** tab → fill in Bits Support / Subscription
   Support (even if both are "not used" for this extension - the fields
   must be explicitly set, not left blank, to advance past Local Test).
4. Console → **Status** → transition the version to **Hosted Test**. Same
   Install-on-your-own-channel flow as Local Test (step 5a.3), now served
   from Twitch's CDN - confirm it still renders/aligns correctly before
   moving on.

### 5c. Review, then Released

Before submitting: Console → **Version Details** tab, fill in every
required field (extension description/screenshots/icons from registration
already covers most of this), plus the extension-specific requirements:
**Review Channel URL** (your own channel, since Twitch's reviewer needs a
live/recent broadcast with the extension actually installed to test
against) and a short **Walkthrough Guide / Change Log** explaining what a
reviewer should expect to see (worth mentioning explicitly: no visible quiz
UI is by design - the reviewer should be told to watch for transparent
hitboxes over Companion's on-screen answer buttons, not a rendered board of
its own). Also confirm **Capabilities** → the Configuration Service
selection matches what this extension actually needs (none, for v1 - no
Config view).

Submit for review from the Status page. Once Twitch approves:

- Console → **Versions** → activate the reviewed version for your own
  channel only (out of scope for v1 to release to the public Extensions
  directory for other broadcasters), or release it to the directory if you
  do want that.

**Do not claim this feature is "live for viewers" until Twitch has actually
accepted and served the extension** - everything above this line is
prepared and ready, but the review/activation step happens entirely on
Twitch's side and cannot be automated or predicted from this repo.
