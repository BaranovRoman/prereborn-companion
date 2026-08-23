# Hard gate run right before "Publish GitHub Release" (WK-88). A
# tag-triggered release must never occupy the public, non-draft "latest"
# slot unless it carries a working installer + updater manifest - without
# this, a partial success (installer built but signing/.sig or latest.json
# generation broke) would silently publish a release that GitHub's
# `/releases/latest` resolves to, breaking both the Tauri updater
# (tauri.conf.json) and web's download-URL resolver
# (scripts/resolve-companion-release.sh), which both trust "latest".
param(
    [Parameter(Mandatory = $true)][string]$Version
)

$ErrorActionPreference = "Stop"
$bundleDir = "apps/companion/src-tauri/target/release/bundle/nsis"

$installer = Get-ChildItem -Path $bundleDir -Filter "*.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $installer) {
    throw "No installer found in $bundleDir - refusing to publish this release."
}

$sha256Path = "$($installer.FullName).sha256"
if (-not (Test-Path $sha256Path)) {
    throw "Missing checksum file for $($installer.Name) - refusing to publish this release."
}

$sigPath = "$($installer.FullName).sig"
if (-not (Test-Path $sigPath)) {
    throw "Missing updater signature ($($installer.Name).sig) - refusing to publish this release. Check TAURI_SIGNING_PRIVATE_KEY."
}

if (-not (Test-Path "latest.json")) {
    throw "Missing latest.json (updater manifest) - refusing to publish this release."
}

$manifest = Get-Content -Path "latest.json" -Raw | ConvertFrom-Json
if ($manifest.version -ne $Version) {
    throw "latest.json version ($($manifest.version)) does not match release version ($Version) - refusing to publish this release."
}
if (-not $manifest.platforms.'windows-x86_64'.url) {
    throw "latest.json is missing a windows-x86_64 download URL - refusing to publish this release."
}

Write-Host "Release asset verification OK for $Version : installer, checksum, signature, latest.json all present and consistent."
