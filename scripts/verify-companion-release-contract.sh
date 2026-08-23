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

# WK-88 follow-up regression guard: a bash-syntax `run:` step (here,
# backslash line-continuation) on a windows-latest job silently runs under
# PowerShell instead unless it declares `shell: bash` - syntactically valid
# YAML, but broken at runtime (first caught when the "Notify production
# deploy" step actually ran for the first time, prereborn-v0.5.21). Scoped
# to this one named step, not a general YAML/shell parser.
check_step_uses_shell_bash() {
  local step_name="$1" file="$2"
  local block
  block=$(awk -v step="$step_name" '
    /- name:/ {
      if (capture) exit
      if (index($0, step)) capture=1
    }
    capture { print }
  ' "$file")
  if [ -z "$block" ]; then
    echo "FAIL: $file has no step named \"$step_name\" (guard target missing/renamed)" >&2
    fail=1
    return
  fi
  if ! grep -q 'shell: *bash' <<<"$block"; then
    echo "FAIL: $file step \"$step_name\" runs on windows-latest with bash-style syntax but no explicit \"shell: bash\" - defaults to pwsh and breaks at runtime" >&2
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

check_step_uses_shell_bash "Notify production deploy of the new release" .github/workflows/windows-release.yml

if [ "$fail" -ne 0 ]; then
  echo "" >&2
  echo "One or more Companion release-contract guards failed - see WK-88." >&2
  exit 1
fi

echo "Companion release contract guards OK."
