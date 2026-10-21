// WK-188 - public product data the landing reads instead of hardcoding it.
// All of it is published by the existing release pipelines; the site only
// reads it (server-side, cached for PUBLIC_DATA_REVALIDATE_SECONDS), so a new
// Companion or plugin release needs no site change.

export const COMPANION_REPO_URL = "https://github.com/BaranovRoman/prereborn-companion";
/** GitHub's stable "latest" release page - the fallback when the build-time installer URL is missing. */
export const COMPANION_LATEST_RELEASE_URL = `${COMPANION_REPO_URL}/releases/latest`;

/** The signed official plugin catalog Companion itself installs from (plugin_manager.rs CATALOG_URL). */
export const PLUGIN_CATALOG_URL =
  "https://github.com/BaranovRoman/prereborn-companion-plugins/releases/download/catalog-v1/catalog.json";

/**
 * Russian user-facing changelog files (changelog/README.md). They live on the
 * Companion release branch, where every Companion and plugin release is cut
 * (AGENTS.MD "How releases actually ship here"), not on `main`.
 */
export const CHANGELOG_BASE_URL =
  "https://raw.githubusercontent.com/BaranovRoman/prereborn-companion/refs/heads/codex/plugin-runtime-prototype/changelog";

export const PUBLIC_DATA_REVALIDATE_SECONDS = 600;
