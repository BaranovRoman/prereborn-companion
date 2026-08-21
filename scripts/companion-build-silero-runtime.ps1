# Builds the local Silero TTS sidecar (WK-81) and packages it as two
# release assets Companion downloads on first opt-in (see
# apps/companion/src-tauri/src/silero.rs): silero-runtime-win-x64.zip (a
# self-contained Python 3.12 + PyTorch CPU runtime + the sidecar script,
# scripts/silero_sidecar.py) and silero-model-v5-5-ru.zip (the ~139MB
# v5_5_ru model weights). Never bundled in the installer itself, never
# assumes a system Python is present on the end user's machine.
#
# NON-COMMERCIAL LICENSE NOTICE: v5_5_ru is distributed by
# snakers4/silero-models under CC BY-NC-SA 4.0. See
# docs/research/wk-74-silero-tts-discovery.md and silero.rs's module
# comment - accepted only for Companion's current non-commercial stage.
#
# Approach validated directly in docs/research/wk-81-silero-tts-feasibility.md:
# a plain `venv` is NOT redistributable (it references the base Python
# install's DLLs) - the official "embeddable package" from python.org is
# the correct, genuinely self-contained mechanism. Also validated there:
# `pip install torch` fails under Windows' MAX_PATH limit unless the build
# root is short - same class of problem companion-build-piper-runtime.ps1
# already works around with its own short `C:\pb` root.
$ErrorActionPreference = "Stop"

$PythonVersion = "3.12.10"
$PythonEmbedUrl = "https://www.python.org/ftp/python/$PythonVersion/python-$PythonVersion-embed-amd64.zip"
$GetPipUrl = "https://bootstrap.pypa.io/get-pip.py"
$ModelUrl = "https://models.silero.ai/models/tts/ru/v5_5_ru.pt"
$ModelFileName = "v5_5_ru.pt"
$BuildRoot = "C:\sr"
$OutDir = Join-Path (Get-Location) "silero-dist"

if (Test-Path $BuildRoot) { Remove-Item -Recurse -Force $BuildRoot }
New-Item -ItemType Directory -Force -Path $BuildRoot | Out-Null
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

$runtimeDir = "$BuildRoot\runtime"
New-Item -ItemType Directory -Force -Path $runtimeDir | Out-Null

Write-Host "=== Downloading Python $PythonVersion embeddable package ==="
Invoke-WebRequest -Uri $PythonEmbedUrl -OutFile "$BuildRoot\python-embed.zip"
Expand-Archive -Path "$BuildRoot\python-embed.zip" -DestinationPath $runtimeDir -Force

Write-Host "=== Enabling site-packages (off by default in the embeddable package) ==="
$pthFile = Get-ChildItem -Path $runtimeDir -Filter "python3*._pth" | Select-Object -First 1
if (-not $pthFile) { throw "Could not find python3xx._pth in the embeddable package" }
@("python312.zip", ".", "Lib\site-packages", "", "import site") | Set-Content -Path $pthFile.FullName -Encoding ascii

Write-Host "=== Bootstrapping pip ==="
Invoke-WebRequest -Uri $GetPipUrl -OutFile "$BuildRoot\get-pip.py"
& "$runtimeDir\python.exe" "$BuildRoot\get-pip.py" --no-warn-script-location
if ($LASTEXITCODE -ne 0) { throw "get-pip.py failed" }

Write-Host "=== Installing PyTorch CPU + numpy ==="
& "$runtimeDir\python.exe" -m pip install torch numpy --index-url https://download.pytorch.org/whl/cpu --no-warn-script-location
if ($LASTEXITCODE -ne 0) { throw "pip install torch failed" }

Write-Host "=== Copying sidecar script ==="
Copy-Item (Join-Path $PSScriptRoot "silero_sidecar.py") $runtimeDir

Write-Host "=== Writing non-commercial license notice ==="
# Mirrors how companion-build-piper-runtime.ps1 bundles GPL-3.0 notice text
# alongside that engine's redistributed binary - here for a different
# reason (NC, not copyleft), but the same "the notice travels with the
# thing it applies to" principle.
@"
Silero TTS model v5_5_ru
Source: https://github.com/snakers4/silero-models
License: CC BY-NC-SA 4.0 (NonCommercial, ShareAlike)
https://github.com/snakers4/silero-models/blob/master/LICENSE

This model is used by PreReborn Companion only while Companion remains a
non-commercial product. Before any commercial use or distribution of
Companion, this dependency must be re-licensed (Silero Enterprise Edition)
or replaced. See docs/research/wk-74-silero-tts-discovery.md and
docs/research/wk-81-silero-tts-feasibility.md in the Companion repository
for the full reasoning.
"@ | Set-Content -Path (Join-Path $runtimeDir "NOTICE-silero-v5_5_ru-CC-BY-NC-SA-4.0.txt") -Encoding utf8

Write-Host "=== Downloading model: $ModelFileName ==="
$modelDir = "$BuildRoot\model"
New-Item -ItemType Directory -Force -Path $modelDir | Out-Null
Invoke-WebRequest -Uri $ModelUrl -OutFile "$modelDir\$ModelFileName"

Write-Host "=== Smoke test: real synthesis through the packaged runtime + JSONL protocol ==="
$smokeOutDir = "$BuildRoot\smoke-out"
New-Item -ItemType Directory -Force -Path $smokeOutDir | Out-Null
$smokePhrase = [System.IO.File]::ReadAllText((Join-Path $PSScriptRoot "companion-silero-smoke-phrase.txt"), [System.Text.Encoding]::UTF8).Trim()

$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = "$runtimeDir\python.exe"
$psi.Arguments = "`"$runtimeDir\silero_sidecar.py`" `"$modelDir\$ModelFileName`" `"$smokeOutDir`""
$psi.RedirectStandardInput = $true
$psi.RedirectStandardOutput = $true
$psi.RedirectStandardError = $true
$psi.UseShellExecute = $false
# Root cause of the earlier smoke-test failures (confirmed via the raw
# bytes the sidecar reported back, not guessed): Windows Python only
# defaults to UTF-8 stdio for an actual interactive console (PEP 528) - a
# piped/redirected stdin like this one falls back to the system's legacy
# ANSI codepage, silently mangling the Cyrillic smoke phrase (and the
# no-BOM write below, without this, still wouldn't help - the sidecar
# would still mis-decode the following bytes). PYTHONUTF8=1 forces UTF-8
# mode regardless of host locale - same fix applied to the real production
# sidecar spawn in silero.rs, not a smoke-test-only workaround.
$psi.EnvironmentVariables["PYTHONUTF8"] = "1"
$proc = [System.Diagnostics.Process]::Start($psi)

$readyLine = $proc.StandardOutput.ReadLine()
Write-Host "Ready line: $readyLine"
$ready = $readyLine | ConvertFrom-Json
if (-not $ready.ready) { throw "Silero sidecar did not report ready: $readyLine" }

$request = @{ id = "smoke-1"; text = $smokePhrase; speaker = "xenia" } | ConvertTo-Json -Compress
# NOT $proc.StandardInput.WriteLine() - that StreamWriter picks its text
# encoding from the current PowerShell host's Console.OutputEncoding,
# which differs between environments; on GitHub Actions' windows-latest
# runner (unlike this script's own local dev-machine test run) it wrote a
# UTF-8 BOM as the very first bytes of stdin, which the sidecar's
# json.loads() doesn't strip - producing "Expecting value: line 1 column 1
# (char 0)" on a request PowerShell itself constructed correctly. Writing
# raw UTF8-no-BOM bytes directly to the underlying stream sidesteps
# whichever encoding the StreamWriter would have picked, in any host.
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$requestBytes = $utf8NoBom.GetBytes("$request`n")
Write-Host "Request string: $request"
Write-Host "Request first 8 bytes (hex): $(($requestBytes[0..7] | ForEach-Object { $_.ToString('x2') }) -join ' ')"
$proc.StandardInput.BaseStream.Write($requestBytes, 0, $requestBytes.Length)
$proc.StandardInput.BaseStream.Flush()
$responseLine = $proc.StandardOutput.ReadLine()
Write-Host "Response line: $responseLine"
$response = $responseLine | ConvertFrom-Json
if (-not $response.ok) { throw "Silero smoke-test synthesis failed: $responseLine" }
if ($response.id -ne "smoke-1") { throw "Silero smoke-test response id mismatch: $responseLine" }

$proc.StandardInput.Close()
$proc.WaitForExit(5000) | Out-Null
if (-not $proc.HasExited) { $proc.Kill() }

$wav = Get-Item $response.wav
if ($wav.Length -lt 1000) { throw "Smoke-test wav is suspiciously small: $($wav.Length) bytes" }
Write-Host "Smoke test OK - wav size: $($wav.Length) bytes"

Write-Host "=== Packaging release assets ==="
# Runtime archive: Python + torch + sidecar script, no model - the model is
# its own asset so a future model update doesn't force re-downloading the
# ~650MB runtime, matching how Piper splits engine vs. voice.
Compress-Archive -Path "$runtimeDir\*" -DestinationPath (Join-Path $OutDir "silero-runtime-win-x64.zip") -Force
Compress-Archive -Path "$modelDir\*" -DestinationPath (Join-Path $OutDir "silero-model-v5-5-ru.zip") -Force

Get-ChildItem $OutDir | ForEach-Object {
    $hash = (Get-FileHash -Path $_.FullName -Algorithm SHA256).Hash.ToLower()
    Set-Content -Path "$($_.FullName).sha256" -Value "$hash  $($_.Name)" -Encoding ascii -NoNewline
    Write-Host "$($_.Name): $([math]::Round($_.Length / 1MB, 2)) MB, sha256 $hash"
}
