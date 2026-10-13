# Inspect built Windows metadata / NSIS contents without installing or opening user data.
param([Parameter(Mandatory=$true)][string]$Version)
$ErrorActionPreference = "Stop"
$exe = Get-Item "apps/companion/src-tauri/target/release/dota-companion.exe"
$actual = $exe.VersionInfo.ProductVersion
if ($actual -notmatch ("^" + [regex]::Escape($Version) + "(\.0)?$")) { throw "Built version $actual differs from $Version" }
$config = Get-Content apps/companion/src-tauri/tauri.conf.json -Raw | ConvertFrom-Json
if ($config.identifier -ne "com.romanbaranov.dota-companion") { throw "App identifier changed" }
if ($config.plugins.updater.endpoints[0] -ne "https://github.com/BaranovRoman/prereborn-companion/releases/latest/download/latest.json") { throw "Stable updater endpoint changed" }
$installers = @(Get-ChildItem apps/companion/src-tauri/target/release/bundle/nsis -Filter "*.exe")
if ($installers.Count -ne 1) { throw "Exactly one NSIS installer required" }
$sevenZip = Join-Path $env:ProgramFiles "7-Zip/7z.exe"
if (-not (Test-Path $sevenZip)) { throw "Runner 7-Zip unavailable; installer inventory unverified" }
$installerPath = $installers[0].FullName
$inventory = & $sevenZip l -slt $installerPath
if ($LASTEXITCODE -ne 0) { throw "NSIS inventory failed" }
$inventory | Set-Content windows-installer-inventory.txt -Encoding utf8
$paths = $inventory | Where-Object { $_ -match '^Path = ' }
if ($paths -match '(?i)companion-dota-plugin|dota2.*\.zip|manifest\.windows-live|private.*\.(key|pem)|signing.*\.(key|pem)') { throw "Unprepared Dota worker/package or private key in core installer" }
$inspectDir = Join-Path $env:RUNNER_TEMP "companion-installer-inspection"
New-Item -ItemType Directory -Force -Path $inspectDir | Out-Null
& $sevenZip e -r -y $installerPath "dota-companion.exe" "-o$inspectDir" | Out-Null
if ($LASTEXITCODE -ne 0) { throw "Installer payload extraction failed" }
$payload = Get-Item (Join-Path $inspectDir "dota-companion.exe")
if ($payload.VersionInfo.ProductVersion -ne $actual) { throw "Installer payload differs from built application version" }
$payloadHash = (Get-FileHash $payload.FullName).Hash
$builtHash = (Get-FileHash $exe.FullName).Hash
Write-Host "Built: $($exe.FullName) bytes=$($exe.Length) sha256=$builtHash"
Write-Host "Extracted: $($payload.FullName) bytes=$($payload.Length) sha256=$payloadHash"
# Tauri intentionally replaces __TAURI_BUNDLE_TYPE_VAR_UNK with ..._NSS in the copy.
# Compare every byte against only that exact SDK patch; no broad PE normalization.
& python scripts/companion-verify-nsis-payload.py $exe.FullName $payload.FullName
if ($LASTEXITCODE -ne 0) { throw "Installer payload verification failed" }
Write-Host "Windows bundle metadata and inventory verified: $Version; BuiltIn remains embedded."
