# Launches the freshly built Companion binary in the clean CI runner and
# confirms it starts without crashing and its local GSI server comes up on
# 127.0.0.1:3665 (see apps/companion/src-tauri/src/state.rs::GSI_PORT).
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
    Write-Host "Smoke test passed: companion launched and GSI server is listening on 127.0.0.1:3665"
}
finally {
    if (-not $proc.HasExited) {
        Stop-Process -Id $proc.Id -Force
    }
}
