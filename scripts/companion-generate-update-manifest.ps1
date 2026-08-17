# Writes latest.json, the manifest apps/companion/src-tauri/tauri.conf.json's
# plugins.updater.endpoints points at (see docs/research/desktop-companion-self-update.md).
# No-ops (exit 0, no file written) when the installer has no .sig next to
# it - that only happens once TAURI_SIGNING_PRIVATE_KEY is configured as a
# repo secret, so releases cut before then are unaffected.
param(
    [Parameter(Mandatory = $true)][string]$Version,
    [Parameter(Mandatory = $true)][string]$Tag,
    [Parameter(Mandatory = $true)][string]$Repository
)

$ErrorActionPreference = "Stop"

$bundleDir = "apps/companion/src-tauri/target/release/bundle/nsis"
$installer = Get-ChildItem -Path $bundleDir -Filter "*.exe" | Select-Object -First 1
if (-not $installer) {
    throw "No installer found in $bundleDir"
}

$sigPath = "$($installer.FullName).sig"
if (-not (Test-Path $sigPath)) {
    Write-Host "No .sig next to $($installer.Name) - signing key not configured yet, skipping latest.json."
    exit 0
}

$signature = (Get-Content -Path $sigPath -Raw).Trim()
$pubDate = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
# GitHub Releases replaces spaces in asset filenames with dots on upload
# (productName "PreReborn Companion" has a space) - the local build output
# still has the space, so the download URL must use the sanitized name or
# it 404s. See prereborn-v0.5.1's latest.json for the bug this fixes.
$sanitizedName = $installer.Name -replace ' ', '.'
$downloadUrl = "https://github.com/$Repository/releases/download/$Tag/$sanitizedName"

$manifest = [ordered]@{
    version   = $Version
    notes     = "See the GitHub Release for full notes."
    pub_date  = $pubDate
    platforms = [ordered]@{
        "windows-x86_64" = [ordered]@{
            signature = $signature
            url       = $downloadUrl
        }
    }
}

# -Encoding utf8 in Windows PowerShell 5.1 always writes a UTF-8 BOM, which
# broke JSON parsing on the client (Tauri updater's HTTP client failed with
# "error decoding response body" - a leading BOM isn't valid JSON to
# serde_json). Content here is pure ASCII (base64 signature, plain URL/date
# strings), so -Encoding ascii is both correct and BOM-free.
$manifest | ConvertTo-Json -Depth 5 | Set-Content -Path "latest.json" -Encoding ascii
Write-Host "Generated latest.json for $Version -> $downloadUrl"
