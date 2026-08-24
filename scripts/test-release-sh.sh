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
# WK-96 follow-up - also proves the artifact-identity fix: two artifacts of
# the SAME commit SHA (different build-time inputs, e.g. a resolved
# Companion release version) are no longer collapsed into a false "already
# current" no-op - see [5/6]/[6/6] below and release.sh's header comment for
# the full root cause this closes.
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

# WK-96 - mirrors release.sh's own BUILD_ID derivation (first 12 hex chars
# of the artifact tarball's sha256) so the test can independently assert
# which release id a deploy should have produced.
build_id_of() { awk '{print $1}' "$1" | cut -c1-12; }

SHA1="testv1$(date +%s)"
echo "=== [1/6] Building artifact v1 ($SHA1) ==="
bash "$ROOT_DIR/scripts/build-release-artifact.sh" "$WORK/artifact-v1" "$SHA1"
BUILD_ID1="$(build_id_of "$WORK/artifact-v1/release.tar.gz.sha256")"
RELEASE_ID1="$SHA1-$BUILD_ID1"

echo "=== [2/6] Deploying v1 (expect success) ==="
DEPLOY_ROOT="$FAKE_ROOT" LOCK_FILE="$WORK/dryrun.lock" API_PORT=5302 WEB_PORT=5300 \
  bash "$ROOT_DIR/release.sh" "$SHA1" "$WORK/artifact-v1/release.tar.gz"
[[ "$(readlink "$FAKE_ROOT/current")" == "releases/$RELEASE_ID1" ]] || { echo "FAIL: current did not switch to v1 ($RELEASE_ID1)"; exit 1; }
curl --fail -s http://127.0.0.1:5300 >/dev/null || { echo "FAIL: v1 web not serving"; exit 1; }
# WK-88 follow-up (production regression) - success case for the
# release-identity check: the running processes must report the SHA that
# was just deployed, not just "some process is listening".
API_SHA="$(curl -fs http://127.0.0.1:5302/api/health | grep -oE '"releaseSha":"[^"]*"' | cut -d'"' -f4)"
[[ "$API_SHA" == "$SHA1" ]] || { echo "FAIL: API releaseSha is '$API_SHA', expected $SHA1"; exit 1; }
# WK-96 - sibling artifact-identity check.
API_BUILD_ID="$(curl -fs http://127.0.0.1:5302/api/health | grep -oE '"releaseBuildId":"[^"]*"' | cut -d'"' -f4)"
[[ "$API_BUILD_ID" == "$BUILD_ID1" ]] || { echo "FAIL: API releaseBuildId is '$API_BUILD_ID', expected $BUILD_ID1"; exit 1; }
WEB_SHA="$(curl -fsI http://127.0.0.1:5300/ | tr -d '\r' | grep -i '^x-release-sha:' | awk '{print $2}')"
[[ "$WEB_SHA" == "$SHA1" ]] || { echo "FAIL: web releaseSha is '$WEB_SHA', expected $SHA1"; exit 1; }
WEB_BUILD_ID="$(curl -fsI http://127.0.0.1:5300/ | tr -d '\r' | grep -i '^x-release-build-id:' | awk '{print $2}')"
[[ "$WEB_BUILD_ID" == "$BUILD_ID1" ]] || { echo "FAIL: web X-Release-Build-Id is '$WEB_BUILD_ID', expected $BUILD_ID1"; exit 1; }
echo "OK: v1 deployed and serving with correct release identity (API + web both report $SHA1 / $BUILD_ID1)"

echo "=== [3/6] Redeploying v1 unchanged (expect safe no-op, same SHA + same artifact) ==="
REDEPLOY_OUTPUT="$(DEPLOY_ROOT="$FAKE_ROOT" LOCK_FILE="$WORK/dryrun.lock" API_PORT=5302 WEB_PORT=5300 \
  bash "$ROOT_DIR/release.sh" "$SHA1" "$WORK/artifact-v1/release.tar.gz" 2>&1)"
grep -q "releases/$RELEASE_ID1 is already current - nothing to do." <<<"$REDEPLOY_OUTPUT" \
  || { echo "FAIL: redeploying the identical artifact should have been a no-op. Output:"; echo "$REDEPLOY_OUTPUT"; exit 1; }
[[ "$(readlink "$FAKE_ROOT/current")" == "releases/$RELEASE_ID1" ]] || { echo "FAIL: current changed on a same-SHA same-artifact redeploy"; exit 1; }
echo "OK: identical redeploy of the same SHA + same artifact was a safe no-op"

echo "=== [4/6] Deploying broken v2 (expect automatic rollback to v1) ==="
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
[[ "$(readlink "$FAKE_ROOT/current")" == "releases/$RELEASE_ID1" ]] || { echo "FAIL: current did not roll back to v1"; exit 1; }
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
echo "=== [5/6] Deploying v3 with a spoofed release identity (simulates the production regression: process boots fine but is NOT the deployed SHA) ==="
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
[[ "$(readlink "$FAKE_ROOT/current")" == "releases/$RELEASE_ID1" ]] || { echo "FAIL: current did not roll back to v1 after spoofed-identity deploy"; exit 1; }
curl --fail -s http://127.0.0.1:5300 >/dev/null || { echo "FAIL: v1 not serving after spoofed-identity rollback"; exit 1; }
ROLLBACK_SHA="$(curl -fsI http://127.0.0.1:5300/ | tr -d '\r' | grep -i '^x-release-sha:' | awk '{print $2}')"
[[ "$ROLLBACK_SHA" == "$SHA1" ]] || { echo "FAIL: after rollback web releaseSha is '$ROLLBACK_SHA', expected $SHA1"; exit 1; }
ROLLBACK_BUILD_ID="$(curl -fsI http://127.0.0.1:5300/ | tr -d '\r' | grep -i '^x-release-build-id:' | awk '{print $2}')"
[[ "$ROLLBACK_BUILD_ID" == "$BUILD_ID1" ]] || { echo "FAIL: after rollback web X-Release-Build-Id is '$ROLLBACK_BUILD_ID', expected $BUILD_ID1"; exit 1; }
echo "OK: spoofed-identity v3 correctly failed release-identity verification (exit $V3_EXIT) and rolled back to v1 with correct identity restored"

# WK-96 - the exact case found in production after WK-53: artifact A and
# artifact B share the SAME commit SHA (no new commit landed between the two
# builds - e.g. a CI-triggered deploy immediately followed by a
# repository_dispatch-triggered rebuild for a just-published Companion
# release), but B's content genuinely differs (a build-time-only input
# changed). B must NOT be discarded as "already current" - it must actually
# go live. Artifact C is then a byte-for-byte copy of B under the same SHA:
# THAT redeploy is expected to be a safe no-op.
echo "=== [6/6] Same SHA, different build inputs: artifact A -> artifact B (must NOT no-op) -> artifact C, a copy of B (must no-op) ==="
SHA_AB="testvab$(date +%s)"

UNPACK_A="$WORK/vab-a-unpack"
mkdir -p "$WORK/artifact-a" "$UNPACK_A"
tar -xzf "$WORK/artifact-v1/release.tar.gz" -C "$UNPACK_A"
printf '%s' "$SHA_AB" > "$UNPACK_A/VERSION"
printf 'companion-version: 0.5.23\n' > "$UNPACK_A/web/BUILD_MARKER"
tar -C "$UNPACK_A" -czf "$WORK/artifact-a/release.tar.gz" .
(cd "$WORK/artifact-a" && shasum -a 256 release.tar.gz > release.tar.gz.sha256)
BUILD_ID_A="$(build_id_of "$WORK/artifact-a/release.tar.gz.sha256")"
RELEASE_ID_A="$SHA_AB-$BUILD_ID_A"

DEPLOY_ROOT="$FAKE_ROOT" LOCK_FILE="$WORK/dryrun.lock" API_PORT=5302 WEB_PORT=5300 \
  bash "$ROOT_DIR/release.sh" "$SHA_AB" "$WORK/artifact-a/release.tar.gz"
[[ "$(readlink "$FAKE_ROOT/current")" == "releases/$RELEASE_ID_A" ]] || { echo "FAIL: current did not switch to artifact A ($RELEASE_ID_A)"; exit 1; }
echo "OK: artifact A ($SHA_AB / $BUILD_ID_A) deployed"

# Artifact B: SAME SHA as A, but different content (simulates a Companion
# release publishing between the two builds - see release.sh's header
# comment) - the marker file's content differs, so the tarball checksum (and
# therefore BUILD_ID) differs even though VERSION/SHA is identical to A.
UNPACK_B="$WORK/vab-b-unpack"
mkdir -p "$WORK/artifact-b" "$UNPACK_B"
tar -xzf "$WORK/artifact-v1/release.tar.gz" -C "$UNPACK_B"
printf '%s' "$SHA_AB" > "$UNPACK_B/VERSION"
printf 'companion-version: 0.5.24\n' > "$UNPACK_B/web/BUILD_MARKER"
tar -C "$UNPACK_B" -czf "$WORK/artifact-b/release.tar.gz" .
(cd "$WORK/artifact-b" && shasum -a 256 release.tar.gz > release.tar.gz.sha256)
BUILD_ID_B="$(build_id_of "$WORK/artifact-b/release.tar.gz.sha256")"
RELEASE_ID_B="$SHA_AB-$BUILD_ID_B"
[[ "$BUILD_ID_B" != "$BUILD_ID_A" ]] || { echo "FAIL: test setup bug - artifact B's checksum did not actually differ from A's"; exit 1; }

DEPLOY_B_OUTPUT="$(DEPLOY_ROOT="$FAKE_ROOT" LOCK_FILE="$WORK/dryrun.lock" API_PORT=5302 WEB_PORT=5300 \
  bash "$ROOT_DIR/release.sh" "$SHA_AB" "$WORK/artifact-b/release.tar.gz" 2>&1)"
if grep -q "already current" <<<"$DEPLOY_B_OUTPUT"; then
  echo "FAIL: artifact B (same SHA as A, different content) was WRONGLY treated as already current. Output:"
  echo "$DEPLOY_B_OUTPUT"
  exit 1
fi
[[ "$(readlink "$FAKE_ROOT/current")" == "releases/$RELEASE_ID_B" ]] || { echo "FAIL: current did not switch to artifact B ($RELEASE_ID_B) - still on $(readlink "$FAKE_ROOT/current")"; exit 1; }
B_API_BUILD_ID="$(curl -fs http://127.0.0.1:5302/api/health | grep -oE '"releaseBuildId":"[^"]*"' | cut -d'"' -f4)"
[[ "$B_API_BUILD_ID" == "$BUILD_ID_B" ]] || { echo "FAIL: after deploying B, API releaseBuildId is '$B_API_BUILD_ID', expected $BUILD_ID_B"; exit 1; }
B_WEB_BUILD_ID="$(curl -fsI http://127.0.0.1:5300/ | tr -d '\r' | grep -i '^x-release-build-id:' | awk '{print $2}')"
[[ "$B_WEB_BUILD_ID" == "$BUILD_ID_B" ]] || { echo "FAIL: after deploying B, web X-Release-Build-Id is '$B_WEB_BUILD_ID', expected $BUILD_ID_B"; exit 1; }
echo "OK: artifact B (same SHA $SHA_AB as A, different content) correctly became current - this is the WK-96 regression case"

# Artifact C: byte-for-byte copy of B, same SHA - a genuinely identical
# redeploy must still be a safe no-op (this is the "don't just delete
# idempotency" half of the contract).
cp "$WORK/artifact-b/release.tar.gz" "$WORK/artifact-b/release.tar.gz.copy"
mkdir -p "$WORK/artifact-c"
cp "$WORK/artifact-b/release.tar.gz" "$WORK/artifact-c/release.tar.gz"
(cd "$WORK/artifact-c" && shasum -a 256 release.tar.gz > release.tar.gz.sha256)
BUILD_ID_C="$(build_id_of "$WORK/artifact-c/release.tar.gz.sha256")"
[[ "$BUILD_ID_C" == "$BUILD_ID_B" ]] || { echo "FAIL: test setup bug - artifact C's checksum should be identical to B's"; exit 1; }

DEPLOY_C_OUTPUT="$(DEPLOY_ROOT="$FAKE_ROOT" LOCK_FILE="$WORK/dryrun.lock" API_PORT=5302 WEB_PORT=5300 \
  bash "$ROOT_DIR/release.sh" "$SHA_AB" "$WORK/artifact-c/release.tar.gz" 2>&1)"
grep -q "releases/$RELEASE_ID_B is already current - nothing to do." <<<"$DEPLOY_C_OUTPUT" \
  || { echo "FAIL: artifact C (byte-identical to B) should have been a safe no-op. Output:"; echo "$DEPLOY_C_OUTPUT"; exit 1; }
[[ "$(readlink "$FAKE_ROOT/current")" == "releases/$RELEASE_ID_B" ]] || { echo "FAIL: current changed on artifact C's no-op redeploy"; exit 1; }
echo "OK: artifact C (byte-identical copy of B, same SHA) was correctly treated as a safe no-op"

echo
echo "=== ALL CHECKS PASSED ==="
