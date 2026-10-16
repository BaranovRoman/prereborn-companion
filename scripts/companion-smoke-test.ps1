# Native packaged-core smoke on the disposable Windows CI account only.
# Game ingestion/rendering is verified by the independent installed-worker tests.
$ErrorActionPreference = "Stop"
if ($env:GITHUB_ACTIONS -ne "true") { throw "Run this automated smoke only on the disposable GitHub Windows runner" }
$exePath = "apps/companion/src-tauri/target/release/dota-companion.exe"
if (-not (Test-Path $exePath)) { throw "Built binary not found at $exePath" }
$dataRoot = Join-Path $env:APPDATA "com.romanbaranov.dota-companion"
$history = Join-Path $dataRoot "local-runtime.sqlite3"
if (Test-Path $history) { throw "Packaged-core smoke requires a clean CI profile, not an existing history" }
function Assert-NoGameListeners {
    foreach ($port in @(3665, 3666)) {
        if (@(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue).Count -ne 0) { throw "Plugin-free Companion must not listen on game port $port" }
    }
}
Assert-NoGameListeners
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
public sealed class CompanionJobProof : IDisposable {
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr OpenJobObject(uint access, bool inherit, string name);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job, int cls, IntPtr info, uint size, IntPtr returned);
    [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool member);
    [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    readonly List<IntPtr> handles = new List<IntPtr>();
    public int BrowserProcesses { get; private set; }
    public static CompanionJobProof Capture(string generation, uint rootPid) {
        var proof = new CompanionJobProof();
        IntPtr job = OpenJobObject(4, false, "Local\\Prereborn.Plugin." + Guid.Parse(generation).ToString());
        if (job == IntPtr.Zero) throw new Exception("Current generation job unavailable");
        IntPtr info = Marshal.AllocHGlobal(8 + 256 * IntPtr.Size);
        IntPtr limits = Marshal.AllocHGlobal(144);
        try {
            if (!QueryInformationJobObject(job, 9, limits, 144, IntPtr.Zero)) throw new Exception("Job limits unproven");
            uint flags = unchecked((uint)Marshal.ReadInt32(limits, 16));
            if ((flags & 0x2000) == 0 || (flags & 0x1800) != 0) throw new Exception("Host job permits unproven child escape");
            if (!QueryInformationJobObject(job, 3, info, (uint)(8 + 256 * IntPtr.Size), IntPtr.Zero)) throw new Exception("Job membership changed during capture");
            int assigned = Marshal.ReadInt32(info, 0), count = Marshal.ReadInt32(info, 4);
            if (count < 2 || count > 256 || count != assigned) throw new Exception("Host/browser membership incomplete");
            bool rootSeen = false;
            for (int i = 0; i < count; i++) {
                uint pid = checked((uint)Marshal.ReadIntPtr(info, 8 + i * IntPtr.Size).ToInt64());
                IntPtr process = OpenProcess(0x101000, false, pid);
                if (process == IntPtr.Zero) throw new Exception("Job process handle unavailable");
                proof.handles.Add(process);
                bool member;
                if (!IsProcessInJob(process, job, out member) || !member || WaitForSingleObject(process, 0) != 258) throw new Exception("Native membership/liveness unproven");
                if (pid == rootPid) rootSeen = true;
                using (var p = Process.GetProcessById((int)pid)) {
                    if (p.ProcessName.Equals("msedgewebview2", StringComparison.OrdinalIgnoreCase)) proof.BrowserProcesses++;
                    if (p.ProcessName.Equals("companion-dota-plugin", StringComparison.OrdinalIgnoreCase)) throw new Exception("Core boot started a game worker");
                }
            }
            if (!rootSeen || proof.BrowserProcesses == 0) throw new Exception("Current core window/browser not contained");
            return proof;
        } catch { proof.Dispose(); throw; }
        finally { Marshal.FreeHGlobal(info); Marshal.FreeHGlobal(limits); CloseHandle(job); }
        // The test NEVER retains a job handle across host crash; doing so would
        // prevent KILL_ON_JOB_CLOSE. Only exact process witnesses remain open.
    }
    public void AssertExited() {
        foreach (var handle in handles) if (WaitForSingleObject(handle, 5000) != 0) throw new Exception("An owned core/browser handle did not signal exit");
    }
    public void Dispose() { foreach (var handle in handles) CloseHandle(handle); handles.Clear(); }
}
'@
$proc = Start-Process -FilePath $exePath -PassThru
$second = $null
$proof = $null
try {
    $ready = $false
    for ($i = 0; $i -lt 30; $i++) {
        Start-Sleep -Milliseconds 500
        $proc.Refresh()
        if ($proc.HasExited) { throw "Companion exited during startup: $($proc.ExitCode)" }
        if ($proc.MainWindowHandle -ne 0) { $ready = $true; break }
    }
    if (-not $ready) { throw "Packaged main window did not become available" }
    Assert-NoGameListeners
    if (Test-Path $history) { throw "Plugin-free startup opened game history or migrated its schema" }
    $journalPath = Join-Path $dataRoot "plugins/infrastructure/transport.sqlite3"
    $readHost = @'
import hashlib, json, pathlib, sqlite3, sys, uuid
path = pathlib.Path(sys.argv[1]).resolve()
with sqlite3.connect(path.as_uri() + '?mode=ro', uri=True) as db:
    document, checksum = db.execute('SELECT record,checksum FROM transport_host WHERE id=1').fetchone()
    assert hashlib.sha256(document.encode()).hexdigest() == checksum
    host = json.loads(document)
    assert host['ready'] and not host.get('retired', False)
    assert host['contract'] == 'windows-host-job-v1'
    assert db.execute('SELECT count(*) FROM transport_processes').fetchone()[0] == 0
    assert db.execute('SELECT count(*) FROM transport_effects').fetchone()[0] == 0
    print(uuid.UUID(host['generation']))
'@
    $generation = & python -c $readHost $journalPath
    if ($LASTEXITCODE -ne 0) { throw "Durable host journal did not confirm a clean plugin-free boot" }
    $generation = ($generation -join "").Trim()
    $second = Start-Process -FilePath $exePath -PassThru
    if (-not $second.WaitForExit(10000) -or $second.ExitCode -ne 0) { throw "Second launch failed the single-instance handoff" }
    $proc.Refresh()
    if ($proc.HasExited) { throw "Second launch disturbed the first core process" }
    Assert-NoGameListeners
    if (Test-Path $history) { throw "Second launch created game history" }
    for ($i = 0; $i -lt 20; $i++) {
        try { $proof = [CompanionJobProof]::Capture($generation, [uint32]$proc.Id); break }
        catch { if ($i -eq 19) { throw }; Start-Sleep -Milliseconds 100 }
    }
    Write-Host "Packaged core ready; contained WebView processes=$($proof.BrowserProcesses); no game listeners, worker, history or effects"
    # Actual host crash, followed by kernel-handle exit proof for WebViews.
    $proc.Kill()
    if (-not $proc.WaitForExit(5000)) { throw "Owned core process did not exit" }
    $proof.AssertExited()
    Assert-NoGameListeners
    Write-Host "Packaged core smoke passed: main window, single instance, durable native containment and browser exit after host crash. No claim of user gameplay/audio/OBS smoke."
}
finally {
    if ($null -ne $second -and -not $second.HasExited) { $second.Kill(); $second.WaitForExit(5000) | Out-Null }
    if (-not $proc.HasExited) { $proc.Kill(); $proc.WaitForExit(5000) | Out-Null }
    if ($null -ne $proof) { $proof.Dispose() }
}
