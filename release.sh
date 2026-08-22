#!/usr/bin/env bash
set -Eeuo pipefail

# WK-80 - production release script. Replaces the old deploy.sh's role:
# instead of building (`pnpm install`/`next build`/`tsc`) on the production
# server, this script only extracts an already-built, versioned artifact
# (see scripts/build-release-artifact.sh, which runs on the GitHub runner),
# runs migrations against its compiled dist/, atomically switches which
# release is "current", reloads PM2, health-checks, and automatically rolls
# back to the previous release if the new one doesn't come up healthy.
#
# See docs/research/wk-80-build-outside-production.md for the full design
# and docs/production-deployment.md for the operational walkthrough.
#
# Usage: release.sh <sha> <artifact-tarball-path>
#
# Overridable via env (defaults match real production; overridden for local
# dry-run testing - see scripts/test-release-sh.sh):
#   DEPLOY_ROOT   (default: /var/www/www-root/data/www/prereborn.ru)
#   LOCK_FILE     (default: /tmp/prereborn-production-deploy.lock - WK-78, unchanged)
#   PM2_BIN       (default: pm2)
#   HEALTH_HOST   (default: 127.0.0.1)
#   API_PORT      (default: 5102)
#   WEB_PORT      (default: 5100)
#   KEEP_RELEASES (default: 5)

SHA="${1:?commit sha required}"
ARTIFACT="${2:?artifact tarball path required}"

DEPLOY_ROOT="${DEPLOY_ROOT:-/var/www/www-root/data/www/prereborn.ru}"
LOCK_FILE="${LOCK_FILE:-/tmp/prereborn-production-deploy.lock}"
PM2_BIN="${PM2_BIN:-pm2}"
HEALTH_HOST="${HEALTH_HOST:-127.0.0.1}"
API_PORT="${API_PORT:-5102}"
WEB_PORT="${WEB_PORT:-5100}"
KEEP_RELEASES="${KEEP_RELEASES:-5}"

# WK-78 - see deploy.sh's original comment: serializes the whole script so
# two overlapping invocations can't race extract/migrate/switch/reload
# against each other. The resource-contention reason from WK-78 (two
# concurrent `pnpm build`s starving the live service) no longer applies
# (production never builds), but the race this closes - two deploys
# fighting over `current`/migrations - still can happen and is just as
# unsafe. Same lock file, same non-blocking semantics, same
# no-trap-needed-because-the-OS-releases-it-on-fd-close reasoning.
exec 200>"$LOCK_FILE"
flock -n 200 || {
  echo "Another deploy is already running (lock: $LOCK_FILE). Aborting."
  exit 1
}

RELEASES_DIR="$DEPLOY_ROOT/releases"
SHARED_DIR="$DEPLOY_ROOT/shared"
RELEASE_DIR="$RELEASES_DIR/$SHA"
CURRENT_LINK="$DEPLOY_ROOT/current"

log() { printf '[release.sh] %s\n' "$*"; }

mkdir -p "$RELEASES_DIR" "$SHARED_DIR/logs" "$DEPLOY_ROOT/apps/api/uploads"
test -f "$SHARED_DIR/.env" || {
  echo "Missing $SHARED_DIR/.env - run the 'Install production environment' step first."
  exit 1
}

# --- Verify artifact integrity before touching anything release-shaped ---
test -f "$ARTIFACT" || { echo "Artifact not found: $ARTIFACT"; exit 1; }
if [[ -f "$ARTIFACT.sha256" ]]; then
  log "Verifying checksum"
  ( cd "$(dirname "$ARTIFACT")" && sha256sum -c "$(basename "$ARTIFACT").sha256" ) \
    || { echo "Checksum verification failed for $ARTIFACT"; exit 1; }
else
  echo "Missing $ARTIFACT.sha256 - refusing to extract an unverified artifact."
  exit 1
fi

# --- Extract into a not-yet-current directory; never overwrite a release
# that's currently live (protects against accidentally re-running a deploy
# for a commit that's already `current`) ---
if [[ -L "$CURRENT_LINK" && "$(readlink "$CURRENT_LINK")" == "releases/$SHA" ]]; then
  echo "releases/$SHA is already current - nothing to do."
  exit 0
fi
rm -rf "$RELEASE_DIR.partial"
mkdir -p "$RELEASE_DIR.partial"
log "Extracting artifact into releases/$SHA.partial"
tar -xzf "$ARTIFACT" -C "$RELEASE_DIR.partial"

test "$(cat "$RELEASE_DIR.partial/VERSION" 2>/dev/null || echo '')" == "$SHA" || {
  echo "VERSION mismatch: expected $SHA, artifact contains $(cat "$RELEASE_DIR.partial/VERSION" 2>/dev/null || echo '<missing>')"
  rm -rf "$RELEASE_DIR.partial"
  exit 1
}
test -f "$RELEASE_DIR.partial/web/apps/web/server.js" || { echo "Artifact missing web/apps/web/server.js"; rm -rf "$RELEASE_DIR.partial"; exit 1; }
test -f "$RELEASE_DIR.partial/api/dist/index.js" || { echo "Artifact missing api/dist/index.js"; rm -rf "$RELEASE_DIR.partial"; exit 1; }
test -f "$RELEASE_DIR.partial/api/dist/db/migrate-cli.js" || { echo "Artifact missing api/dist/db/migrate-cli.js"; rm -rf "$RELEASE_DIR.partial"; exit 1; }
test -f "$RELEASE_DIR.partial/ecosystem.config.cjs" || { echo "Artifact missing ecosystem.config.cjs"; rm -rf "$RELEASE_DIR.partial"; exit 1; }

rm -rf "$RELEASE_DIR"
mv "$RELEASE_DIR.partial" "$RELEASE_DIR"
log "Extracted and verified releases/$SHA"

# --- Capture the previous release for rollback, before switching anything ---
PREVIOUS_SHA=""
if [[ -L "$CURRENT_LINK" ]]; then
  PREVIOUS_TARGET="$(readlink "$CURRENT_LINK")"
  PREVIOUS_SHA="${PREVIOUS_TARGET#releases/}"
fi

# --- Migrations run against the NEW release's compiled dist/, while
# `current` still points at the OLD release - see docs/research/
# wk-80-build-outside-production.md #7/#8: migrations are additive-only, so
# the still-running old release is unaffected by the new schema. If this
# fails, `current` is never touched. ---
log "Running migrations (dist/db/migrate-cli.js)"
set -a
# shellcheck disable=SC1091
source "$SHARED_DIR/.env"
set +a
export UPLOADS_DIR="${UPLOADS_DIR:-$DEPLOY_ROOT/apps/api/uploads}"
if ! node "$RELEASE_DIR/api/dist/db/migrate-cli.js"; then
  echo "Migration failed for releases/$SHA - current release (${PREVIOUS_SHA:-none}) left untouched and still serving."
  exit 1
fi

health_check() {
  local label="$1"
  local response
  if ! response="$(curl --fail --silent --show-error \
      --retry 10 --retry-delay 2 --retry-connrefused \
      "http://$HEALTH_HOST:$API_PORT/api/health")"; then
    log "$label: API health check request failed"
    return 1
  fi
  printf '%s\n' "$response"
  if ! grep -q '"status":"ok"' <<<"$response"; then
    log "$label: API health check did not report ok"
    return 1
  fi
  grep -q '"twitchConfigured":true' <<<"$response" || { log "$label: twitchConfigured is not true"; return 1; }
  grep -q '"donationAlertsConfigured":true' <<<"$response" || { log "$label: donationAlertsConfigured is not true"; return 1; }
  curl --fail --silent --show-error --head \
    --retry 10 --retry-delay 2 --retry-connrefused \
    "http://$HEALTH_HOST:$WEB_PORT" >/dev/null || { log "$label: web root check failed"; return 1; }
  return 0
}

switch_and_reload() {
  local sha="$1"
  ln -sfn "releases/$sha" "$DEPLOY_ROOT/current.tmp"
  mv -Tf "$DEPLOY_ROOT/current.tmp" "$CURRENT_LINK"
  cp "$RELEASES_DIR/$sha/ecosystem.config.cjs" "$SHARED_DIR/ecosystem.config.cjs"
  "$PM2_BIN" reload "$SHARED_DIR/ecosystem.config.cjs" --update-env
  "$PM2_BIN" restart prereborn-api --update-env
}

log "Switching current -> releases/$SHA"
switch_and_reload "$SHA"

if health_check "post-switch"; then
  log "releases/$SHA is healthy - deploy successful"
  "$PM2_BIN" save

  # --- Retention: keep the newest KEEP_RELEASES releases, never the one
  # `current` points at or `shared/`. Cleanup failure must never turn a
  # successful deploy into a reported failure. ---
  set +e
  mapfile -t all_releases < <(ls -1 "$RELEASES_DIR" | sort)
  keep_count=${#all_releases[@]}
  if (( keep_count > KEEP_RELEASES )); then
    to_delete=$(( keep_count - KEEP_RELEASES ))
    for old in "${all_releases[@]:0:$to_delete}"; do
      if [[ "releases/$old" != "$(readlink "$CURRENT_LINK")" ]]; then
        log "Pruning old release: $old"
        rm -rf "${RELEASES_DIR:?}/$old"
      fi
    done
  fi
  set -e
  exit 0
fi

echo "Health check failed for releases/$SHA."

if [[ -z "$PREVIOUS_SHA" ]]; then
  echo "No previous release to roll back to (this was the first artifact deploy). PRODUCTION MAY BE DOWN - manual intervention required."
  exit 1
fi

log "Rolling back: current -> releases/$PREVIOUS_SHA"
switch_and_reload "$PREVIOUS_SHA"

if health_check "post-rollback"; then
  echo "Rolled back successfully to releases/$PREVIOUS_SHA. Deploy of $SHA failed but production is healthy on the previous release."
  exit 1
fi

echo "ROLLBACK ALSO FAILED. PRODUCTION REQUIRES IMMEDIATE MANUAL INTERVENTION. Neither releases/$SHA nor releases/$PREVIOUS_SHA is confirmed healthy."
exit 1
