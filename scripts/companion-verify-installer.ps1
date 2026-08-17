# Verifies a downloaded Companion installer against its published
# `<installer>.exe.sha256` (see docs/companion-release.md). Expects the
# checksum file to sit next to the installer with the same base name, as
# published by scripts/companion-checksums.ps1 in the release workflow.
param(
    [Parameter(Mandatory = $true)]
    [string]$InstallerPath
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path $InstallerPath)) {
    throw "Installer not found: $InstallerPath"
}

$checksumPath = "$InstallerPath.sha256"
if (-not (Test-Path $checksumPath)) {
    throw "Checksum file not found: $checksumPath (download it alongside the installer from the GitHub Release)"
}

$expected = (Get-Content -Path $checksumPath -Raw).Trim().Split(" ")[0].ToLower()
$actual = (Get-FileHash -Path $InstallerPath -Algorithm SHA256).Hash.ToLower()

if ($actual -ne $expected) {
    throw "Checksum MISMATCH for $InstallerPath`nExpected: $expected`nActual:   $actual`nDo not run this installer - re-download it."
}

Write-Host "Checksum OK: $InstallerPath matches $checksumPath"
