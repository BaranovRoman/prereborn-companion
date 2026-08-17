# libpiper Windows build spike — results + implementation plan (WK-74)

Follow-up to
[local-tts-licensing.md](local-tts-licensing.md), which recommended a
self-built `OHF-Voice/piper1-gpl` `libpiper` CLI run as a Companion
subprocess. This spike verifies that build is real and reproducible —
locally and on GitHub Actions `windows-latest` — before opening an
implementation ticket. **No application code was touched.** Companion and
the Piper CLI were never in the same process during this spike; nothing
in `apps/companion/src-tauri` was linked against `piper.dll`/`espeak-ng`.

**Result: spike succeeded.** Both local and CI builds are green, the
architectural boundary held, and licensing obligations from the prior doc
are unchanged. Recommendation at the bottom — do not start the full
integration without a separate go-ahead, per instruction.

## What was built

`OHF-Voice/piper1-gpl` pinned to `v1.7.0` (commit `7b8e8f7`,
2026-08-15), `libpiper/` subdirectory only, via its own documented CMake
flow (`libpiper/README.md`) — this automatically fetches and statically
builds `espeak-ng` and downloads `onnxruntime` as external projects; no
Python involved anywhere in the build. The repo's own
`libpiper/src/main/main.cpp` already provides a full standalone CLI
(`piper_exe.exe`) — no first-party wrapper needed to be written, contrary
to what the licensing doc assumed ("no official standalone CLI ships"
turned out to be about *release binaries*, not *source*).

## Local build — two real gotchas, both fixed

Built with VS 2022 Build Tools (MSVC 19.44, CMake 3.31.6, Ninja 1.12.1)
already installed on this machine.

1. **MAX_PATH (260 chars).** First attempt, from a long temp/scratchpad
   path, failed two ways: `git clone` of `espeak-ng` couldn't create some
   of its own deeply-nested Android test file paths ("Filename too
   long"), and later CMake/Ninja failed generating a try-compile project
   because an object-file directory path was 271 characters ("The
   maximum full path to an object file is 250 characters"). Fixed by
   building from a short root (`C:\pb`) instead. This is the same failure
   class (not the same bug) as the Cyrillic-username `espeak-ng-data`
   loading issue found in the earlier
   [prototype](wk-74-piper-prototype-findings.md) — Windows path length
   and non-ASCII encoding are two separate hazards, both triggered by
   "this machine's actual paths are longer/weirder than upstream expects."
2. **DLL colocation.** `cmake --install` puts `piper_exe.exe` in
   `install/bin/` but `piper.dll`, `onnxruntime.dll`, and
   `onnxruntime_providers_shared.dll` in `install/lib/` — separate
   directories. The Windows loader doesn't search a sibling `lib/`
   automatically; running the exe as-is fails with `STATUS_DLL_NOT_FOUND`
   (0xC0000135). Fixed by copying the three DLLs next to the exe (what
   Companion's bundling step will need to do for real — see plan below).

Once both were fixed, synthesis worked correctly end to end.

### Local performance (this exact build, `ru_RU-denis-medium`)

| Scenario | Result |
|---|---|
| Single phrase, fresh process (repeated 4x, no warm-up speedup observed) | **~1.05–1.2 s** consistently |
| 5 chat-length lines, one persistent process | 1732 ms total → **~126–136 ms/line** after the ~1.1s load |
| 20 chat-length lines, one persistent process | 6022 ms total → **~246 ms/line** average after load |
| Peak working set (20-line batch) | **154.0 MB** |
| Redistributable disk footprint (excludes `onnxruntime.pdb`, a 355MB *debug-symbols* file not needed for shipping) | exe 145KB + `piper.dll` 773KB + `onnxruntime.dll` 12.4MB + `onnxruntime_providers_shared.dll` 22KB + `espeak-ng-data` 19MB ≈ **32.3 MB** |

Compare to the earlier prototype's 2023 MIT `piper.exe` build: ~220ms
load, 15–110ms/message, 147MB peak RAM. This build's per-message cost
is roughly **2× higher** (126–246ms vs 15–110ms) and process-launch
doesn't show the same dramatic OS-cache warm-up speedup the old build
did. Still comfortably fast enough for chat-pace TTS (a message every
~150-250ms is imperceptible as a bottleneck for reading chat aloud), but
this is a real, honest difference worth carrying into the implementation
ticket rather than assuming the old numbers still apply — likely
explained by a newer, larger `onnxruntime` (1.22.0) doing more
provider-registration work at load time; not investigated further here as
it doesn't change the go/no-go decision.

## CI build — failed once (my script's bug), then succeeded clean

Workflow: [`.github/workflows/piper-libpiper-spike.yml`](../../.github/workflows/piper-libpiper-spike.yml),
`workflow_dispatch`-only, never wired into the real release pipeline
(`windows-release.yml` untouched). Getting it to actually run needed a
brief, scoped `push` trigger (GitHub won't let `workflow_dispatch` be
API/CLI-triggered until the workflow file exists on the default branch,
which this spike deliberately never touched) — reverted immediately after
each of the two runs it triggered; both runs and both reverts are on
`feat/74` only, nothing touched `main`.

**Run 1 (`32040754252`) — failed**, and it was a bug in the spike script,
not a libpiper problem: the script hardcoded `vcvarsall.bat`'s path under
`...\2022\Enterprise\` / `...\2022\BuildTools\`, both calls failed to find
that path, and — because the combined `call A || call B` line wasn't
itself checked for failure — the script carried on with MSVC never set up.
CMake then silently picked up a pre-installed MinGW toolchain
(`C:\mingw64\bin\c++.exe`) instead, which failed compiling
`main.cpp` (`'CP_UTF8' was not declared`, `'SetConsoleOutputCP' was not
declared` — a MinGW/MSVC header-visibility gap, not a licensing or
architecture problem).

**Root cause**: this runner has **Visual Studio 2026** (18.8.2), not
2022, installed at `C:\Program Files\Microsoft Visual Studio\18\Enterprise`
— a new folder-numbering scheme. Hardcoding VS paths is fragile across
runner image updates; the fix was `vswhere`-based dynamic discovery (the
same approach already used successfully in this spike's own "Record
environment" step and in the local build script), plus a hard failure
(`where cl`) if the compiler still isn't on `PATH` afterward instead of
silently falling through to whatever CMake finds on its own.

**Run 2 (`32040929441`) — succeeded, every step green:**

- Toolchain actually used: **MSVC 19.51.36252.0** (`cl.exe` from
  `VC/Tools/MSVC/14.51.36231`), **CMake 4.4.2**, **Ninja 1.13.2**, on
  Visual Studio 2026 Enterprise 18.8.2.
- Configure → build → install → DLL colocation → voice download → smoke
  test → artifact upload, all passed.
- Smoke test: synthesized "Привет стример, как дела в игре сегодня?"
  end-to-end on a clean runner → valid 226,348-byte WAV, `piper_exe.exe`
  exit code 0.
- CI-measured redistributable sizes (matches local within noise):
  `onnxruntime.dll` 11.84MB, `onnxruntime_providers_shared.dll` 0.02MB,
  `piper.dll` 0.74MB, `piper_exe.exe` 0.15MB (12.75MB) + `espeak-ng-data`
  17.6MB ≈ **30.4MB total**.
- Artifacts (exe, DLLs, `piper.h`, smoke-test WAV) uploaded to the run for
  inspection; the workflow file itself is back to `workflow_dispatch`-only
  on `feat/74`, not auto-triggering on future pushes.

## Architectural boundary — held throughout

No `piper-rs`, no FFI, no linking of `piper.dll`/`espeak-ng` into
`apps/companion/src-tauri`. The spike's Cargo/Rust surface was untouched;
`piper_exe.exe` was only ever exercised as a wholly separate process via
its documented CLI (stdin text in, `--output_file`/`--output_dir` WAV
out) — exactly the subprocess/IPC shape the licensing doc classified as
**A: ACCEPTABLE**.

## Implementation plan for WK-74 (proposed, not started)

Everything below is a plan only — no code was written toward it. Flagging
per your list of must-preserve constraints, mapped to concrete decisions:

**Sidecar lifecycle**
- Persistent process, not process-per-message: spawn `piper_exe.exe`
  once, keep its stdin open, feed one line per chat message, read one WAV
  (or `--output_dir`-numbered file / raw stdout via `--output_raw`) back
  per line — matches what was measured above (~130-250ms/message once
  resident, vs. ~1.1s if relaunched per message).
- **Lazy start**: only spawn the sidecar the first time local TTS is
  actually enabled in settings, not at Companion startup — mirrors how
  `TwitchEventSubChatClient` in the API is only created on first use
  (`ensureTwitchChat`), not eagerly.
- **Shutdown/restart**: close stdin + wait/kill on TTS-disable or app
  exit (same pattern as the existing `queue.current.clear()` +
  `speechSynthesis.cancel()` immediate-stop already in
  `TwitchChatPage.tsx`); restart-on-crash needed since this is a
  long-lived external process the Rust side doesn't control the internals
  of — a dead sidecar should be detected and respawned lazily on the next
  message, not silently drop all further TTS.
- **Fallback**: if the sidecar fails to spawn (binary/model missing,
  Windows blocked it, etc.) or exits unexpectedly, fall back to the
  existing `window.speechSynthesis` path from WK-66 rather than going
  silent — local neural TTS is additive, not a hard replacement.

**Preserve from WK-66** (`chat-model.ts`): `BoundedTtsQueue`
(limit 3, drop-oldest, 15s staleness eviction), the message-id dedup
`Set`, and `prepareTtsText()`'s filtering (message-type allowlist,
repeated-char spam filter, URL→"ссылка" replacement, length truncation)
all sit *above* the synthesis call and don't change — only what
`drainTts()` hands off to (browser `speechSynthesis` vs. the new sidecar)
changes, gated by a settings field (e.g. `ttsEngine: "system" |
"piper"`).

**Voices**: bundle `ru_RU-denis-medium` (MIT/CC0, verified) as the only
shipped voice initially; `ru_RU-dmitri-medium` (also MIT/CC0) is a
same-shape follow-up once the first voice ships, not blocking day one.

**Cyrillic Windows usernames — must be explicitly tested, not assumed
fixed.** The path-encoding failure was confirmed against the *old* 2023
binary in the earlier prototype; it was never re-tested against *this*
build (the CI runner's username isn't Cyrillic, so this run doesn't prove
anything either way). Before shipping: always pass an explicit
`--espeak_data <path>` pointing inside `app_data_dir()` rather than
relying on cwd-relative resolution, and specifically test on a machine
with a Cyrillic Windows username — this app's own target audience.

**Storage lifecycle**: model + engine binary/DLLs should live under
`app.path().app_data_dir()` (the existing convention in
`storage/mod.rs` — e.g. `logs_root()`/`payloads_dir()` already follow
this pattern), not inside the installer's own install directory, so they
survive Companion auto-updates (`windows-release.yml`'s
`prereborn-v*`-tagged releases replace the install dir's contents) and so
the ~30MB voice+engine download only happens once, on first opt-in, not
on every update.

**CI**: `windows-release.yml` currently has no C/C++ toolchain step; the
libpiper build (now proven to work with `vswhere`-based MSVC discovery)
would need its own build stage there, producing the exe+DLLs+
`espeak-ng-data` as a bundled resource — a small, separate addition to
that workflow, not a rewrite of it.

**Licensing obligations to implement** (from
[local-tts-licensing.md](local-tts-licensing.md), still applicable, not
yet done): GPL-3.0 license text + source-offer for the redistributed
`piper.dll`/`espeak-ng` build, MIT notices for `piper_exe.exe` and the
voice model — an about/licenses screen or equivalent, scoped to whichever
UI surface makes sense at implementation time.

## Recommendation

**Spike succeeded** — proceed to write the WK-74 implementation ticket
using this exact combination (self-built `libpiper` CLI, subprocess
sidecar, `ru_RU-denis-medium`), informed by the plan above. Two things
worth resolving before or during that ticket, not before this report:
Cyrillic-username testing against this specific build, and the
`windows-release.yml` CI integration for the libpiper build step.

**Stopping here per instruction — not starting the Tauri/React/Twitch
chat integration without a separate go-ahead.**
