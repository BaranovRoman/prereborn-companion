# Builds the local Piper TTS sidecar (WK-75) and packages it as two release
# assets Companion downloads on first opt-in (see
# apps/companion/src-tauri/src/tts.rs) rather than bundling in the
# installer: piper-runtime-win-x64.zip (engine) and
# piper-voice-ru_RU-dmitri-medium.zip (voice). Not linked into Companion's
# own binary anywhere - see docs/research/local-tts-licensing.md for why
# that boundary matters.
#
# Reuses the exact approach verified in docs/research/wk-74-libpiper-ci-spike.md:
# short build path (MAX_PATH), vswhere-based MSVC discovery with a hard
# failure instead of a silent wrong-compiler fallback, DLLs colocated next
# to the exe.
$ErrorActionPreference = "Stop"

$PiperVersion = "v1.7.0"
# ru_RU-dmitri-medium, not denis (WK-77 quality audit) - both MIT/CC0, but
# a spectral comparison found dmitri meaningfully brighter/less muffled
# than denis at the same 22050Hz medium-quality tier. See
# docs/research/wk-77-tts-quality-audit.md.
$VoiceName = "ru_RU-dmitri-medium"
# piper-voices' HF repo layout is <lang>/<lang_LOCALE>/<voice>/<quality>/ -
# not derivable from $VoiceName alone (it's lang_LOCALE-voice-quality),
# hence spelled out explicitly rather than regex-guessed.
$VoiceHfPath = "ru/ru_RU/dmitri/medium"
$BuildRoot = "C:\pb"
$OutDir = Join-Path (Get-Location) "piper-dist"

if (Test-Path $BuildRoot) { Remove-Item -Recurse -Force $BuildRoot }
New-Item -ItemType Directory -Force -Path $BuildRoot | Out-Null
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

Write-Host "=== Cloning OHF-Voice/piper1-gpl $PiperVersion ==="
git clone --depth 1 --branch $PiperVersion https://github.com/OHF-Voice/piper1-gpl.git "$BuildRoot\piper1-gpl"
if ($LASTEXITCODE -ne 0) { throw "git clone failed" }

Write-Host "=== Locating MSVC via vswhere (never hardcode a VS version/path) ==="
$vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
$vsPath = & $vswhere -latest -products * -property installationPath
if (-not $vsPath) { throw "vswhere found no Visual Studio installation" }
Write-Host "Using VS install: $vsPath"

$buildScript = @"
call "$vsPath\VC\Auxiliary\Build\vcvarsall.bat" x64
if errorlevel 1 exit /b 1
where cl
if errorlevel 1 (
  echo cl.exe not on PATH after vcvarsall - refusing to silently fall back to another compiler
  exit /b 1
)
set PATH=$vsPath\Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin;$vsPath\Common7\IDE\CommonExtensions\Microsoft\CMake\Ninja;%PATH%
cd /d "$BuildRoot\piper1-gpl\libpiper"
cmake -G Ninja -B build -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX=%CD%\install
if errorlevel 1 exit /b 1
cmake --build build --config Release
if errorlevel 1 exit /b 1
cmake --install build --config Release
if errorlevel 1 exit /b 1
"@
$buildScriptPath = "$BuildRoot\build.bat"
Set-Content -Path $buildScriptPath -Value $buildScript -Encoding ascii

Write-Host "=== Building libpiper (Release) ==="
cmd.exe /d /s /c "`"$buildScriptPath`""
if ($LASTEXITCODE -ne 0) { throw "libpiper build failed" }

$installDir = "$BuildRoot\piper1-gpl\libpiper\install"
$binDir = "$installDir\bin"

Write-Host "=== Colocating runtime DLLs with piper_exe.exe ==="
Copy-Item "$installDir\lib\piper.dll" $binDir
Copy-Item "$installDir\lib\onnxruntime.dll" $binDir
Copy-Item "$installDir\lib\onnxruntime_providers_shared.dll" $binDir

Write-Host "=== Downloading voice: $VoiceName ==="
$voiceDir = "$BuildRoot\voice"
New-Item -ItemType Directory -Force -Path $voiceDir | Out-Null
Invoke-WebRequest -Uri "https://huggingface.co/rhasspy/piper-voices/resolve/main/$VoiceHfPath/$VoiceName.onnx" -OutFile "$voiceDir\$VoiceName.onnx"
Invoke-WebRequest -Uri "https://huggingface.co/rhasspy/piper-voices/resolve/main/$VoiceHfPath/$VoiceName.onnx.json" -OutFile "$voiceDir\$VoiceName.onnx.json"

Write-Host "=== Smoke test: real synthesis with the packaged engine + voice ==="
$smokePhrase = [System.IO.File]::ReadAllText((Join-Path $PSScriptRoot "companion-piper-smoke-phrase.txt"), [System.Text.Encoding]::UTF8)
$smokeWav = "$BuildRoot\smoke.wav"
# NOT `$phrase | & exe ...` - under a non-interactive PowerShell host (this
# script via -File, same as every GitHub Actions `shell: powershell` step)
# that pipe form reliably fed this specific piper_exe.exe build 0 bytes of
# stdin (confirmed by hand while writing this script: reproduced, then
# fixed, with the exact repro below). Driving stdin explicitly through
# Process/StandardInput works correctly every time.
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = "$binDir\piper_exe.exe"
$psi.Arguments = "--model `"$voiceDir\$VoiceName.onnx`" --espeak_data `"$installDir\share\espeak-ng-data`" --output_file `"$smokeWav`""
$psi.RedirectStandardInput = $true
$psi.UseShellExecute = $false
$proc = [System.Diagnostics.Process]::Start($psi)
$proc.StandardInput.Write("$smokePhrase`n")
$proc.StandardInput.Close()
$proc.WaitForExit()
if ($proc.ExitCode -ne 0) { throw "Piper smoke-test synthesis failed with exit code $($proc.ExitCode)" }
$wav = Get-Item $smokeWav
if ($wav.Length -lt 1000) { throw "Smoke-test wav is suspiciously small: $($wav.Length) bytes" }
Write-Host "Smoke test OK - wav size: $($wav.Length) bytes"

Write-Host "=== Packaging release assets ==="
# Runtime archive: exe + DLLs (no .pdb - debug symbols, not needed to run)
# + espeak-ng-data. No voice model in here - voices are their own asset so
# future additional voices don't require re-downloading the engine.
$runtimeStaging = "$BuildRoot\runtime-staging"
New-Item -ItemType Directory -Force -Path $runtimeStaging | Out-Null
Copy-Item "$binDir\piper_exe.exe" $runtimeStaging
Copy-Item "$binDir\piper.dll" $runtimeStaging
Copy-Item "$binDir\onnxruntime.dll" $runtimeStaging
Copy-Item "$binDir\onnxruntime_providers_shared.dll" $runtimeStaging
Copy-Item "$installDir\share\espeak-ng-data" (Join-Path $runtimeStaging "espeak-ng-data") -Recurse
Copy-Item "$BuildRoot\piper1-gpl\COPYING" (Join-Path $runtimeStaging "COPYING.piper1-gpl-GPL-3.0.txt")
Compress-Archive -Path "$runtimeStaging\*" -DestinationPath (Join-Path $OutDir "piper-runtime-win-x64.zip") -Force

$voiceZipName = "piper-voice-$VoiceName.zip"
Compress-Archive -Path "$voiceDir\*" -DestinationPath (Join-Path $OutDir $voiceZipName) -Force

Get-ChildItem $OutDir | ForEach-Object {
    $hash = (Get-FileHash -Path $_.FullName -Algorithm SHA256).Hash.ToLower()
    Set-Content -Path "$($_.FullName).sha256" -Value "$hash  $($_.Name)" -Encoding ascii -NoNewline
    Write-Host "$($_.Name): $([math]::Round($_.Length / 1MB, 2)) MB, sha256 $hash"
}
