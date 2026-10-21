# WK-189: account page, /admin users, and the 10 registered accounts

## Question
Which parts of the old web cabinet (`/stream`) does the current Companion still need, what
replaces it, and why does the public stats block show 10 registered accounts?

## Current state (before WK-189)
- `/stream` was a full stream-control cabinet: onboarding, Companion token panel, game mode
  (ranked/unranked), stream session (W/L, new stream), Steam + Dota sync, Twitch and
  DonationAlerts panels, OBS guide and test mode, quick match, recent matches, queue
  widgets, and a separate overlay layout editor (`/stream/overlay-editor`).
- Auth is client-only: JWT access token (1h) + rotating refresh token (30d) in
  `localStorage` (`apps/web/src/entities/stream-user/lib/tokens.ts`). The server can't
  see the session, so the public header was static and always said "Войти".
- Admin is an email allowlist (`ADMIN_EMAILS`), enforced by `requireAdmin` on
  `/api/admin/*`. There are no roles or account status columns in `stream_users`.

## Findings (confirmed in code, release branch `codex/plugin-runtime-prototype`)
- **Companion sign-in is email + password** (`apps/companion/src-tauri/src/backend/mod.rs`
  `login` → `POST /api/stream/auth/login`, WK-122). The Companion UI no longer calls
  `save_companion_token`, so the old static "companion token" can't be entered anywhere.
  The backend still accepts one (`authenticateCompanionSession` falls back to the hash
  lookup) for installs that saved it earlier.
- **Steam linking still needs the site.** Companion's "Привязать Steam" runs
  `open_stream_settings` → `https://prereborn.ru/stream`, and Steam OpenID returns to the
  site. The Dota 2 plugin's OpenDota widgets (`/stream/integrations/opendota/*`) read that
  link.
- **Twitch and DonationAlerts are connected from Companion**, but their OAuth callbacks
  redirected the browser to `/stream?twitch=…` / `?donationAlerts=…`.
- Everything else on the old cabinet (OBS, TTS, chat, widgets, overlay layout, game mode,
  sessions) is configured in Companion or its plugins.
- **Registered count** = `SELECT COUNT(*) FROM stream_users` (`computeUsageStats`), no
  filtering. Every row is an account created through `POST /api/stream/auth/register`.
  There is no other code path that inserts into `stream_users` outside tests.
- **Activity** comes only from the Companion heartbeat (WK-186), recorded since
  **2026-10-21**. Versions before WK-186 send nothing; nothing was backfilled.

## The 10 accounts (production, 2026-10-22)
- `GET https://prereborn.ru/api/public/usage-stats` →
  `registeredUsers: 10, activeUsers7d: 2, activeUsers30d: 2, trackingSince: 2026-10-21`.
- So: 10 rows in `stream_users`; **2 distinct accounts sent a Companion heartbeat** in the
  observed period (2026-10-21 onward, i.e. about one day of tracking). The other 8 have no
  heartbeat since tracking started. That doesn't prove they never used Companion: a
  pre-WK-186 version or a launch before 2026-10-21 leaves no trace.
- Per-account creation dates and signals (Steam/Twitch link, legacy token, last heartbeat)
  are on the new `/admin` screen. They were not read during implementation because the
  production DB and an admin session were not available to the agent. Why individual
  accounts were created is **not known from the data**, and the data has no
  source/referrer field.

## Decision
- `/account` replaces `/stream`: account facts, how Companion connects (email/password; no
  token to copy), revoke-only for a still-existing legacy token, Steam link/unlink for the
  Dota 2 plugin, sign out, and an `/admin` link for admins.
- No new legacy token is issued: the current Companion has nowhere to paste it. Revoking
  one only affects installs authenticating with it; sessions are untouched.
- `/stream` → `/account` (query string kept, so OAuth results still display);
  `/stream/overlay-editor` → `/account`. API callbacks now redirect to `/account` directly.
- `/stream/login`, `/stream/register`, `/stream/queue`, `/stream/download`,
  `/overlay/[publicToken]` are unchanged. Backend APIs for the removed panels are kept:
  they are also used by Companion/plugins or overlays.
- `/admin` "Пользователи": summary (WK-186 definitions) + table with ID, email, registration,
  last Companion heartbeat, active days in 30, Steam/Twitch/legacy-token signals, admin tag;
  search, server-side sorting, pagination. No status column, because the model has none.
  No destructive actions were added.

## Follow-up
- Read the per-account breakdown on `/admin` (as an admin) and add it below if it matters.
- Companion could later open `/account` instead of `/stream`; the redirect makes that
  optional.
