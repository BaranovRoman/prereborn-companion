#!/usr/bin/env bash
set -Eeuo pipefail

# WK-80 - builds a self-contained, versioned production release artifact on
# a GitHub-hosted runner (or locally, for testing) so production never runs
# `pnpm install`, `next build`, or `tsc` itself. See
# docs/research/wk-80-build-outside-production.md for the design.
#
# Assumes `pnpm install --frozen-lockfile` already ran for the whole
# workspace (this script only builds/assembles, it doesn't install).
#
# Usage: scripts/build-release-artifact.sh <output-dir> <sha>
#   <output-dir>  where to write release.tar.gz + release.tar.gz.sha256
#   <sha>         commit SHA this artifact represents (written to VERSION)
#
# Required env (build-time, non-secret - see docs/operations/production-env.md):
#   NEXT_PUBLIC_API_URL, NEXT_PUBLIC_SITE_URL, NEXT_PUBLIC_MEDIA_BASE_URL,
#   NEXT_PUBLIC_DOTA_COMPANION_DOWNLOAD_URL

OUT_DIR="${1:?output dir required}"
SHA="${2:?commit sha required}"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

echo "=== Building web (output: standalone) ==="
(cd "$ROOT_DIR" && corepack pnpm --filter @prereborn/web build)

echo "=== Building API (tsc) ==="
(cd "$ROOT_DIR" && corepack pnpm --filter @prereborn/api build)

echo "=== Assembling web artifact ==="
mkdir -p "$STAGE/web"
cp -R "$ROOT_DIR/apps/web/.next/standalone/." "$STAGE/web/"
# Standalone tracing deliberately excludes static assets and public/ (see
# Next's own docs) - the running standalone server still needs them locally
# since nginx proxies everything to the Node process rather than serving
# .next/static or public/ off disk itself (nginx.production.conf has no
# `root`-based static serving for the app). Copying them in here, once, at
# build time, means the shipped artifact is directly runnable with no
# post-extraction assembly step on the server.
mkdir -p "$STAGE/web/apps/web/.next/static"
cp -R "$ROOT_DIR/apps/web/.next/static/." "$STAGE/web/apps/web/.next/static/"
mkdir -p "$STAGE/web/apps/web/public"
# Valve match-replay video cache is already excluded from today's rsync
# (deploy-production.yml) for size - same reasoning applies here.
rsync -a --exclude='vendor/valve/video/' "$ROOT_DIR/apps/web/public/." "$STAGE/web/apps/web/public/"

echo "=== Assembling API artifact (pnpm deploy --prod) ==="
API_DEPLOY_STAGE="$STAGE/.api-deploy"
# --legacy: pnpm v10's default deploy implementation refuses non-injected
# workspaces (ERR_PNPM_DEPLOY_NONINJECTED_WORKSPACE) - this workspace has no
# `workspace:*` cross-package deps at all (verified: apps/web and apps/api
# build fully independently), so the legacy implementation is exactly the
# right fit, not a compatibility workaround.
(cd "$ROOT_DIR" && corepack pnpm deploy --filter @prereborn/api --prod --legacy "$API_DEPLOY_STAGE")
mkdir -p "$STAGE/api"
cp -R "$API_DEPLOY_STAGE/dist" "$STAGE/api/dist"
cp -R "$API_DEPLOY_STAGE/node_modules" "$STAGE/api/node_modules"
cp "$API_DEPLOY_STAGE/package.json" "$STAGE/api/package.json"

echo "=== Writing VERSION and ecosystem config ==="
printf '%s' "$SHA" > "$STAGE/VERSION"
cp "$ROOT_DIR/ecosystem.config.cjs" "$STAGE/ecosystem.config.cjs"

echo "=== Verifying required entrypoints exist ==="
test -f "$STAGE/web/apps/web/server.js" || { echo "missing web/apps/web/server.js"; exit 1; }
test -f "$STAGE/api/dist/index.js" || { echo "missing api/dist/index.js"; exit 1; }
test -f "$STAGE/api/dist/db/migrate-cli.js" || { echo "missing api/dist/db/migrate-cli.js"; exit 1; }

echo "=== Archiving ==="
mkdir -p "$OUT_DIR"
tar -C "$STAGE" -czf "$OUT_DIR/release.tar.gz" .
(cd "$OUT_DIR" && sha256sum release.tar.gz > release.tar.gz.sha256 2>/dev/null \
  || shasum -a 256 release.tar.gz > release.tar.gz.sha256)

echo "=== Done ==="
du -sh "$OUT_DIR/release.tar.gz"
cat "$OUT_DIR/release.tar.gz.sha256"
