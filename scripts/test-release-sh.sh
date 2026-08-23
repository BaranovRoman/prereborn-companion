#!/usr/bin/env bash
set -Eeuo pipefail

# WK-80 - local dry run of release.sh against a fake DEPLOY_ROOT, using real
# artifacts, real PM2, and a real (throwaway) Postgres database - no
# production server involved. Proves the extract -> verify -> migrate ->
# atomic switch -> health check -> automatic rollback logic actually works
# before it ever runs against the real server. See
# docs/research/wk-80-build-outside-production.md #13 ("test artifact
# before production") and #7 (failure/rollback matrix).
#
# Requires: a reachable local Postgres the current OS user can create
# databases on, and `pm2` on PATH. On macOS, also requires GNU coreutils'
# `mv`/`gmv` (`brew install coreutils`) since release.sh's atomic switch
# uses `mv -T`, a GNU extension the production server (Ubuntu) has natively
# but BSD/macOS `mv` does not - this script only prepends the GNU coreutils
# gnubin dir to PATH for itself, it never touches release.sh.
#
# Usage: scripts/test-release-sh.sh

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ "$(uname)" == "Darwin" ]] && [[ -d /opt/homebrew/opt/coreutils/libexec/gnubin ]]; then
  export PATH="/opt/homebrew/opt/coreutils/libexec/gnubin:$PATH"
fi

WORK="$(mktemp -d)"
cleanup() {
  pm2 delete prereborn-api prereborn-web >/dev/null 2>&1 || true
  # Terminate any lingering pool connections (the API's pg pool can outlive
  # the killed process by a moment) before dropping, or dropdb races them.
  psql -h 127.0.0.1 -d postgres -c \
    "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = 'wk80_release_sh_test';" \
    >/dev/null 2>&1 || true
  dropdb -h 127.0.0.1 wk80_release_sh_test >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

TEST_DB="wk80_release_sh_test"
dropdb -h 127.0.0.1 "$TEST_DB" >/dev/null 2>&1 || true
createdb -h 127.0.0.1 "$TEST_DB"

FAKE_ROOT="$WORK/fake-prod-root"
mkdir -p "$FAKE_ROOT/shared/logs" "$FAKE_ROOT/apps/api/uploads"
cat > "$FAKE_ROOT/shared/.env" <<EOF
DATABASE_URL=postgresql://$(whoami)@127.0.0.1:5432/$TEST_DB
STREAM_JWT_SECRET=dryrun-secret-at-least-32-characters-long-ok
ADMIN_EMAILS=
CORS_ALLOWED_ORIGINS=http://127.0.0.1:5300
TWITCH_CLIENT_ID=dryrun-twitch-id
TWITCH_CLIENT_SECRET=dryrun-twitch-secret
TWITCH_REDIRECT_URI=http://127.0.0.1:5300/api/stream/integrations/twitch/callback
DONATION_ALERTS_CLIENT_ID=dryrun-da-id
DONATION_ALERTS_CLIENT_SECRET=dryrun-da-secret
EOF

export NEXT_PUBLIC_API_URL=/api
export NEXT_PUBLIC_SITE_URL=https://prereborn.ru
export NEXT_PUBLIC_MEDIA_BASE_URL=https://prereborn.ru/media
export NEXT_PUBLIC_DOTA_COMPANION_DOWNLOAD_URL=https://github.com/BaranovRoman/prereborn-companion/releases/latest

SHA1="testv1$(date +%s)"
echo "=== [1/3] Building artifact v1 ($SHA1) ==="
bash "$ROOT_DIR/scripts/build-release-artifact.sh" "$WORK/artifact-v1" "$SHA1"

echo "=== [2/4] Deploying v1 (expect success) ==="
DEPLOY_ROOT="$FAKE_ROOT" LOCK_FILE="$WORK/dryrun.lock" API_PORT=5302 WEB_PORT=5300 \
  bash "$ROOT_DIR/release.sh" "$SHA1" "$WORK/artifact-v1/release.tar.gz"
[[ "$(readlink "$FAKE_ROOT/current")" == "releases/$SHA1" ]] || { echo "FAIL: current did not switch to v1"; exit 1; }
curl --fail -s http://127.0.0.1:5300 >/dev/null || { echo "FAIL: v1 web not serving"; exit 1; }
# WK-88 follow-up (production regression) - success case for the
# release-identity check: the running processes must report the SHA that
# was just deployed, not just "some process is listening".
API_SHA="$(curl -fs http://127.0.0.1:5302/api/health | grep -oE '"releaseSha":"[^"]*"' | cut -d'"' -f4)"
[[ "$API_SHA" == "$SHA1" ]] || { echo "FAIL: API releaseSha is '$API_SHA', expected $SHA1"; exit 1; }
WEB_SHA="$(curl -fsI http://127.0.0.1:5300/ | tr -d '\r' | grep -i '^x-release-sha:' | awk '{print $2}')"
[[ "$WEB_SHA" == "$SHA1" ]] || { echo "FAIL: web releaseSha is '$WEB_SHA', expected $SHA1"; exit 1; }
echo "OK: v1 deployed and serving with correct release identity (API + web both report $SHA1)"

echo "=== [3/4] Deploying broken v2 (expect automatic rollback to v1) ==="
SHA2="testv2$(date +%s)"
UNPACK="$WORK/v2-unpack"
mkdir -p "$WORK/artifact-v2" "$UNPACK"
tar -xzf "$WORK/artifact-v1/release.tar.gz" -C "$UNPACK"
printf '%s' "$SHA2" > "$UNPACK/VERSION"
cat > "$UNPACK/web/apps/web/server.js" <<'EOF'
console.error("simulated boot crash for WK-80 rollback dry run");
process.exit(1);
EOF
tar -C "$UNPACK" -czf "$WORK/artifact-v2/release.tar.gz" .
(cd "$WORK/artifact-v2" && shasum -a 256 release.tar.gz > release.tar.gz.sha256)

set +e
DEPLOY_ROOT="$FAKE_ROOT" LOCK_FILE="$WORK/dryrun.lock" API_PORT=5302 WEB_PORT=5300 \
  bash "$ROOT_DIR/release.sh" "$SHA2" "$WORK/artifact-v2/release.tar.gz"
V2_EXIT=$?
set -e
[[ "$V2_EXIT" -ne 0 ]] || { echo "FAIL: broken v2 deploy should have exited non-zero"; exit 1; }
[[ "$(readlink "$FAKE_ROOT/current")" == "releases/$SHA1" ]] || { echo "FAIL: current did not roll back to v1"; exit 1; }
curl --fail -s http://127.0.0.1:5300 >/dev/null || { echo "FAIL: v1 not serving after rollback"; exit 1; }
echo "OK: broken v2 correctly failed (exit $V2_EXIT) and rolled back to v1, which is still serving"

# WK-88 follow-up (production regression) - reproduces the actual bug class
# that shipped to production: a release that boots completely fine (HTTP
# 200, valid JSON, twitchConfigured etc. - everything the OLD health check
# verified) but is NOT actually the SHA that was supposed to go live. This
# is what "PM2 silently kept an old process running" looks like from
# health_check's point of view, without depending on reproducing the exact
# PM2 internals - v3 is a byte-for-byte copy of the known-good v1 build,
# except its ecosystem.config.cjs hardcodes a release SHA that doesn't match
# what release.sh is deploying.
echo "=== [4/4] Deploying v3 with a spoofed release identity (simulates the production regression: process boots fine but is NOT the deployed SHA) ==="
SHA3="testv3$(date +%s)"
UNPACK3="$WORK/v3-unpack"
mkdir -p "$WORK/artifact-v3" "$UNPACK3"
tar -xzf "$WORK/artifact-v1/release.tar.gz" -C "$UNPACK3"
printf '%s' "$SHA3" > "$UNPACK3/VERSION"
sed -i.bak 's/process\.env\.PREREBORN_RELEASE_SHA || ""/"spoofed-does-not-match"/' "$UNPACK3/ecosystem.config.cjs"
rm -f "$UNPACK3/ecosystem.config.cjs.bak"
tar -C "$UNPACK3" -czf "$WORK/artifact-v3/release.tar.gz" .
(cd "$WORK/artifact-v3" && shasum -a 256 release.tar.gz > release.tar.gz.sha256)

set +e
DEPLOY_ROOT="$FAKE_ROOT" LOCK_FILE="$WORK/dryrun.lock" API_PORT=5302 WEB_PORT=5300 \
  bash "$ROOT_DIR/release.sh" "$SHA3" "$WORK/artifact-v3/release.tar.gz"
V3_EXIT=$?
set -e
[[ "$V3_EXIT" -ne 0 ]] || { echo "FAIL: spoofed-identity v3 deploy should have exited non-zero"; exit 1; }
[[ "$(readlink "$FAKE_ROOT/current")" == "releases/$SHA1" ]] || { echo "FAIL: current did not roll back to v1 after spoofed-identity deploy"; exit 1; }
curl --fail -s http://127.0.0.1:5300 >/dev/null || { echo "FAIL: v1 not serving after spoofed-identity rollback"; exit 1; }
ROLLBACK_SHA="$(curl -fsI http://127.0.0.1:5300/ | tr -d '\r' | grep -i '^x-release-sha:' | awk '{print $2}')"
[[ "$ROLLBACK_SHA" == "$SHA1" ]] || { echo "FAIL: after rollback web releaseSha is '$ROLLBACK_SHA', expected $SHA1"; exit 1; }
echo "OK: spoofed-identity v3 correctly failed release-identity verification (exit $V3_EXIT) and rolled back to v1 with correct identity restored"

echo
echo "=== ALL CHECKS PASSED ==="
