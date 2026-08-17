# Writes a `<file>.sha256` next to each NSIS installer so beta users (and
# WK-70's in-app updater, later) can verify a downloaded artifact wasn't
# corrupted or tampered with in transit.
$ErrorActionPreference = "Stop"

$bundleDir = "apps/companion/src-tauri/target/release/bundle/nsis"
$installers = Get-ChildItem -Path $bundleDir -Filter "*.exe"
if ($installers.Count -eq 0) {
    throw "No installer artifacts found in $bundleDir"
}

foreach ($file in $installers) {
    $hash = Get-FileHash -Path $file.FullName -Algorithm SHA256
    $line = "$($hash.Hash.ToLower())  $($file.Name)"
    Set-Content -Path "$($file.FullName).sha256" -Value $line -Encoding ascii -NoNewline
    Write-Host "Checksum written for $($file.Name): $($hash.Hash.ToLower())"
}
