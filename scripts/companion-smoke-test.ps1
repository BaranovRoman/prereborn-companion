# Launches the freshly built Companion binary in the clean CI runner and
# confirms it starts without crashing, its local GSI server comes up on
# 127.0.0.1:3665, and the exact localhost overlay URL used by OBS serves
# the packaged renderer plus current state/SSE on 127.0.0.1:3666.
# Run from the repo root after `tauri build`. Does not exercise the
# production backend connection (that needs a real companion token, which
# has no safe CI secret) - this only proves the release binary boots.
$ErrorActionPreference = "Stop"

$exePath = "apps/companion/src-tauri/target/release/dota-companion.exe"
if (-not (Test-Path $exePath)) {
    throw "Built binary not found at $exePath"
}

$proc = Start-Process -FilePath $exePath -PassThru
try {
    $listening = $false
    for ($i = 0; $i -lt 20; $i++) {
        Start-Sleep -Seconds 1
        $proc.Refresh()
        if ($proc.HasExited) {
            throw "Companion process exited unexpectedly during smoke test (exit code $($proc.ExitCode))"
        }
        $conn = Test-NetConnection -ComputerName 127.0.0.1 -Port 3665 -WarningAction SilentlyContinue
        if ($conn.TcpTestSucceeded) {
            $listening = $true
            break
        }
    }
    if (-not $listening) {
        throw "GSI server on 127.0.0.1:3665 never came up within timeout"
    }
    $overlayBase = "http://127.0.0.1:3666/overlay"
    $overlayReady = $false
    for ($i = 0; $i -lt 20; $i++) {
        try {
            $health = Invoke-RestMethod -Uri "$overlayBase/health" -TimeoutSec 2
            if ($health.status -eq "ok") {
                $overlayReady = $true
                break
            }
        }
        catch {
            Start-Sleep -Seconds 1
        }
    }
    if (-not $overlayReady) {
        throw "Local overlay server at $overlayBase never became healthy within timeout"
    }

    $html = (Invoke-WebRequest -UseBasicParsing -Uri $overlayBase -TimeoutSec 5).Content
    if (-not $html.Contains('id="root"') -or -not $html.Contains('/overlay/events')) {
        throw "Canonical OBS Browser Source URL did not serve the packaged overlay renderer"
    }

    $draftPayload = '{"map":{"game_state":"DOTA_GAMERULES_STATE_HERO_SELECTION"},"player":{"activity":"playing"}}'
    Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:3665" -ContentType "application/json" -Body $draftPayload | Out-Null
    Start-Sleep -Milliseconds 500
    $draftState = Invoke-RestMethod -Uri "$overlayBase/state" -TimeoutSec 5
    if ($draftState.scene -ne "draft") {
        throw "Packaged overlay did not resolve the populated Draft state (actual: $($draftState.scene))"
    }

    $gameplayPayload = '{"map":{"game_state":"DOTA_GAMERULES_STATE_GAME_IN_PROGRESS"},"player":{"activity":"playing"}}'
    Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:3665" -ContentType "application/json" -Body $gameplayPayload | Out-Null
    Start-Sleep -Milliseconds 500
    $gameplayState = Invoke-RestMethod -Uri "$overlayBase/state" -TimeoutSec 5
    if ($gameplayState.scene -ne "gameplay") {
        throw "Packaged overlay did not resolve the populated Gameplay state (actual: $($gameplayState.scene))"
    }

    $sse = & curl.exe --silent --no-buffer --max-time 2 "$overlayBase/events" 2>$null
    if (($LASTEXITCODE -ne 0 -and $LASTEXITCODE -ne 28) -or -not (($sse -join "`n").Contains('"scene":"gameplay"'))) {
        throw "Fresh Browser Source SSE connection did not immediately receive the current Gameplay snapshot"
    }
    # curl exits 28 because the SSE stream intentionally remains open until
    # --max-time stops it. The frame assertion above proves that this is the
    # expected successful path; clear the native exit code so Windows
    # PowerShell does not report the otherwise-successful script as failed.
    $global:LASTEXITCODE = 0

    # Reliability pass - single-instance guard (tauri-plugin-single-instance,
    # registered first in lib.rs's run()). This is the one real-Windows check
    # for it this repo runs anywhere: PRs never build the Tauri app at all
    # (ci.yml is Node/Ubuntu-only, and windows-release.yml only triggers on
    # push to main/tags - see the report), so this smoke test is the only
    # place a genuine double-launch on the actual target OS is exercised.
    # Not a substitute for the manual window-focus verification the report
    # calls for (this CI runner has no interactive desktop session to
    # observe a window actually coming to the foreground on) - it proves the
    # part that IS machine-checkable: a second launch must not become a
    # second running runtime and must not disturb the first instance's
    # already-bound ports.
    $secondProc = Start-Process -FilePath $exePath -PassThru
    $secondInstanceExited = $false
    for ($i = 0; $i -lt 10; $i++) {
        Start-Sleep -Milliseconds 500
        $secondProc.Refresh()
        if ($secondProc.HasExited) {
            $secondInstanceExited = $true
            break
        }
    }
    if (-not $secondInstanceExited) {
        Stop-Process -Id $secondProc.Id -Force -ErrorAction SilentlyContinue
        throw "Second Companion launch did not exit - single-instance guard did not take effect (or took too long)"
    }
    if ($secondProc.ExitCode -ne 0) {
        throw "Second Companion launch exited with code $($secondProc.ExitCode) instead of a clean single-instance handoff (expected 0)"
    }

    $runningCount = (Get-Process -Name "dota-companion" -ErrorAction SilentlyContinue | Measure-Object).Count
    if ($runningCount -ne 1) {
        throw "Expected exactly 1 running dota-companion.exe process after the second launch handed off, found $runningCount"
    }

    $proc.Refresh()
    if ($proc.HasExited) {
        throw "First Companion instance exited as a side effect of the second launch attempt"
    }
    $conn = Test-NetConnection -ComputerName 127.0.0.1 -Port 3665 -WarningAction SilentlyContinue
    if (-not $conn.TcpTestSucceeded) {
        throw "First instance's GSI server on 127.0.0.1:3665 stopped responding after the second launch attempt"
    }
    $health = Invoke-RestMethod -Uri "$overlayBase/health" -TimeoutSec 5
    if ($health.status -ne "ok") {
        throw "First instance's overlay server stopped responding after the second launch attempt"
    }

    Write-Host "Smoke test passed: packaged Companion serves GSI + canonical OBS overlay HTML/state/initial SSE; Draft and Gameplay states resolved; a second launch exits cleanly and the first instance's runtime is undisturbed"
}
finally {
    if (-not $proc.HasExited) {
        Stop-Process -Id $proc.Id -Force
    }
}
