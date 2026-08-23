#!/usr/bin/env bash
set -Eeuo pipefail

# WK-88 regression guard, run in CI (see .github/workflows/ci.yml). Prevents
# reintroducing the exact defect this ticket fixed: a hardcoded Companion
# release tag/version baked into the public web download config, and the
# release workflow's asset-verification gate being silently removed. Pure
# static grep - no network, no build.

cd "$(git rev-parse --show-toplevel)"

fail=0

check_absent() {
  local pattern="$1" file="$2" label="$3"
  if grep -Eq "$pattern" "$file"; then
    echo "FAIL: $label ($file matches /$pattern/)" >&2
    fail=1
  fi
}

check_present() {
  local pattern="$1" file="$2" label="$3"
  if ! grep -Eq "$pattern" "$file"; then
    echo "FAIL: $label ($file missing /$pattern/)" >&2
    fail=1
  fi
}

check_absent 'prereborn-v[0-9]' .github/workflows/deploy-production.yml \
  "deploy-production.yml must not hardcode a Companion release tag"
check_absent '_x64-setup\.exe' .github/workflows/deploy-production.yml \
  "deploy-production.yml must not hardcode a versioned installer filename"
check_absent '"[0-9]+\.[0-9]+\.[0-9]+"' apps/web/src/shared/config/dota-companion.ts \
  "dota-companion.ts must not hardcode a Companion version literal"

check_present 'resolve-companion-release\.sh' .github/workflows/deploy-production.yml \
  "deploy-production.yml must resolve the Companion download URL via scripts/resolve-companion-release.sh"
check_present 'companion-verify-release-assets\.ps1' .github/workflows/windows-release.yml \
  "windows-release.yml must run the release asset verification gate before publishing"
check_present 'fail_on_unmatched_files: true' .github/workflows/windows-release.yml \
  "windows-release.yml's Publish GitHub Release step must fail on unmatched files"

if [ "$fail" -ne 0 ]; then
  echo "" >&2
  echo "One or more Companion release-contract guards failed - see WK-88." >&2
  exit 1
fi

echo "Companion release contract guards OK."
