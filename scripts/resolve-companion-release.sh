#!/usr/bin/env bash
set -Eeuo pipefail

# WK-88 - single source of truth for what the public "Скачать для Windows"
# button on the web download page points at: whatever GitHub currently
# resolves as this repo's "latest" Companion release
# (github.com/<repo>/releases/latest). This is the SAME resolution the
# Tauri updater already trusts (apps/companion/src-tauri/tauri.conf.json's
# updater endpoint), and windows-release.yml's
# companion-verify-release-assets.ps1 gate ensures a failed/partial
# Companion build can never occupy that "latest" slot - see that script and
# the "Publish failed build log" step's removal for the enforcement side.
#
# Runs once at web build time (deploy-production.yml), not per page load -
# no runtime GitHub API dependency for site visitors, and no manual edit of
# deploy-production.yml is ever needed again after a Companion release.
#
# Requires: gh CLI authenticated via GH_TOKEN, jq. Writes
# COMPANION_DOWNLOAD_URL / COMPANION_VERSION to $GITHUB_ENV.

REPO="${GITHUB_REPOSITORY:-BaranovRoman/prereborn-companion}"

release_json="$(gh api "repos/$REPO/releases/latest")"

tag_name="$(jq -r '.tag_name // empty' <<<"$release_json")"
if [ -z "$tag_name" ]; then
  echo "Could not resolve a latest release for $REPO" >&2
  exit 1
fi

version="${tag_name#prereborn-v}"

download_url="$(jq -r '[.assets[] | select(.name | test("_x64-setup\\.exe$"))][0].browser_download_url // empty' <<<"$release_json")"
if [ -z "$download_url" ]; then
  echo "Latest release $tag_name has no Windows x64 installer asset - refusing to resolve a download URL" >&2
  exit 1
fi

{
  echo "COMPANION_DOWNLOAD_URL=$download_url"
  echo "COMPANION_VERSION=$version"
} >>"$GITHUB_ENV"

echo "Resolved Companion latest release: $tag_name -> $download_url"
