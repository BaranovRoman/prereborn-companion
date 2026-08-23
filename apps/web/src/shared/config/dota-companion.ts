// WK-88 - both values are resolved at web build time from GitHub's "latest"
// Companion release (see scripts/resolve-companion-release.sh and
// .github/workflows/deploy-production.yml), never hardcoded here. `null`
// means the value wasn't resolved (e.g. local dev without the build step) -
// callers must handle that, same as the existing download-URL fallback UI.
export const DOTA_COMPANION_VERSION: string | null =
  process.env.NEXT_PUBLIC_DOTA_COMPANION_VERSION || null;
export const DOTA_COMPANION_DOWNLOAD_URL: string | null =
  process.env.NEXT_PUBLIC_DOTA_COMPANION_DOWNLOAD_URL || null;
