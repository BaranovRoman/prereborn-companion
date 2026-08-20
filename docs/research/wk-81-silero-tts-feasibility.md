# Silero TTS integration feasibility (WK-81)

## Question

WK-74's original discovery (`wk-74-silero-tts-discovery.md`) stopped short of
integrating Silero `v5_5_ru` for two independent blockers: no ONNX (or other
non-Python) inference path exists, and the model is CC BY-NC-SA 4.0
(non-commercial). WK-81 explicitly accepts the non-commercial license for
Companion's current non-commercial stage, which removes blocker #2 as a
stop condition. This leaves blocker #1: is a genuinely self-contained
Windows Python+PyTorch sidecar — one that ships to end users with zero
manual install step — actually buildable and stable enough to integrate?
WK-74 deliberately never prototyped this (doing the heavy, then-license-
blocked work just to measure it was flagged as the wrong order of
operations). This document is that prototype, now that the license
question is resolved for this stage.

## Current state

Companion already ships one local neural TTS sidecar (Piper, WK-75/77/79):
a persistent child process spawned from Rust, fed one line of text per
utterance over stdin, read back via an exact per-request completion signal
on stdout (not directory polling — see `tts.rs`'s WK-79 comment for the bug
class that fix replaced). Engine + voice are downloaded on first opt-in
into `app_data_dir()`, never bundled in the installer.

## Findings

All measured directly on this dev machine (Windows 11, no GPU), outside
the repo, nothing committed as binary artifacts.

### Packaging mechanism that actually ships to users

A plain `venv` is **not** redistributable — it references the base Python
install's DLLs/interpreter, which end users don't have. The correct
mechanism, confirmed working end-to-end, is Python's official
**embeddable package** (`python-3.12.10-embed-amd64.zip` from
python.org, ~11MB) — designed by python.org specifically for embedding in
applications:

1. Extract the embeddable zip.
2. Edit `python312._pth` to add `Lib\site-packages` and uncomment
   `import site` (required for `pip`/third-party packages to be importable
   at all — off by default in the embeddable distribution).
3. Bootstrap `pip` via `get-pip.py`.
4. `python.exe -m pip install torch numpy --index-url
   https://download.pytorch.org/whl/cpu` — installs straight into the
   embeddable tree's `Lib\site-packages`, no system Python involved.

Confirmed: this produces a fully self-contained folder (`python.exe` +
`Lib\site-packages\torch\...`) that runs and synthesizes correctly with
**no Python installed on the machine otherwise** — validated by running it
from a location with no other Python on `PATH` pointing at it.

### Windows MAX_PATH is a real, hit-not-assumed blocker for this specific install

First install attempt, under a long scratch path (`C:\Users\...\AppData\
Local\Temp\claude\...\scratchpad\silero-spike\venv\...`), failed outright:

```
ERROR: Could not install packages due to an OSError: [Errno 2] No such
file or directory: 'C:\Users\...\site-packages\pkg_resources\tests\data\
my-test-package_unpacked-egg\my_test_package-1.0-py3.7.egg\EGG-INFO\
dependency_links.txt'
HINT: This error might have occurred since this system does not have
Windows Long Path support enabled.
```

Retried under a short path (`C:\sil-spike`, mirroring the existing
`companion-build-piper-runtime.ps1`'s own `C:\pb` convention for exactly
this reason) and it installed cleanly. **The Silero build script must use
a short build root**, same as Piper's already does — not a new problem,
the existing convention already solves it.

### Real synthesis measurements (embeddable-Python runtime, CPU, `v5_5_ru`)

Loaded via `torch.package.PackageImporter(model_path).load_pickle(...)` —
the only documented loading path (see WK-74 doc; no ONNX export exists).

| Metric | Value |
|---|---|
| Cold interpreter + `import torch` | ~1.2 s |
| Model load (`PackageImporter` + `.to(cpu)`) | ~490–520 ms |
| Warm synthesis RTF (phrases 2–6, all voices) | ~0.027–0.032 (i.e. ~30× real-time) |
| First-call RTF (cold, includes model warmup) | ~0.42 |
| Peak RAM during a 6-phrase run (`tasklist`-measured, matches the method used in `companion-tts-voice-comparison.md`) | **~830 MB** |
| Runtime folder on disk (embeddable Python + torch + numpy, unpacked) | **~670 MB** |
| Model file (`v5_5_ru.pt`) | **139 MB** (145,420,684 bytes, confirmed via `Content-Length`) |
| Total uncompressed footprint | **~810 MB** |
| All 5 named voices (`aidar`, `baya`, `kseniya`, `xenia`, `eugene`) | All synthesize successfully from the same model file — confirmed by direct per-voice calls, not assumed from the model card |

For comparison, Piper (`companion-tts-voice-comparison.md`): ~900–990 ms
cold start, ~206 MB peak RAM, ~60 MB per-voice model, warm RTF ~0.08.
Silero is **slower to start** (extra Python interpreter + `import torch`
overhead) but **faster once warm** (~3× lower RTF) and **heavier on RAM**
(~4× Piper's). None of this crosses a hard blocker per WK-81's explicit
allowance ("несколько сотен MB" RAM/size is not itself a blocker) — but
~830MB RAM is at the upper edge of "several hundred," not comfortably
inside it, and is called out here rather than rounded down.

**Actual end-user download size is much smaller than the uncompressed
footprint suggests.** Running the real packaging script
(`companion-build-silero-runtime.ps1`) end-to-end — not just estimating
from the ~810MB uncompressed folder — produced:

| Asset | Compressed (zipped) size |
|---|---|
| `silero-runtime-win-x64.zip` (Python 3.12 embeddable + PyTorch CPU + sidecar script) | **177.69 MB** |
| `silero-model-v5-5-ru.zip` | **111.18 MB** |
| **Total first-opt-in download** | **~289 MB** |

Comfortably inside "several hundred MB," not at the edge of it — the
uncompressed 810MB figure above is disk footprint *after* extraction, not
what the user actually downloads.

### Request/response IPC — validated, not just designed

A minimal JSONL sidecar (`silero_sidecar.py`) was run for real against the
embeddable runtime: reads `{"id","text","speaker"}` lines from stdin,
prints a `{"ready":true}` line once the model is loaded, then one
`{"id","ok","wav"}` (or `{"id","ok":false,"error"}`) line per request,
strictly correlated by `id` — no directory polling, no "newest file"
guessing, the same class of bug WK-79 fixed for Piper is structurally
impossible here since the id is explicit in both directions. Verified with
3 concurrent-looking requests across 3 different voices in one process
lifetime; each returned its own correctly-sized WAV.

## Options

1. **Ship the embeddable-Python + PyTorch CPU sidecar as designed above,
   downloaded on first opt-in** (same lifecycle convention as Piper).
   Feasible, validated end-to-end. Heavier than Piper but within the
   task's explicit size/RAM allowance.
2. **Stop here per WK-81's stop criterion.** Would apply if packaging
   turned out to require a manual user-side Python install, or if the
   runtime were unstable. Neither happened — the embeddable package is
   genuinely self-contained and every run in this spike succeeded.

## Recommendation

Proceed with option 1. Silero becomes the primary synthesis backend,
Piper `dmitri` remains the fallback, system `speechSynthesis` remains the
last resort — implemented as a new sidecar module alongside (not
replacing) `tts.rs`, following the same download-on-opt-in,
resident-process, id-correlated-IPC architecture already proven for Piper.

## Follow-up

Implementation ticket: this one (WK-81). Scope: `silero.rs` (Rust sidecar
management, mirroring `tts.rs`), `silero_sidecar.py` (the protocol script,
committed to the repo and packaged into the runtime zip at release time,
not written ad hoc), a `companion-build-silero-runtime.ps1` packaging
script mirroring `companion-build-piper-runtime.ps1`, frontend voice
selector + preview + fallback chain, and CI wiring in
`windows-release.yml`.

## Sources

- [wk-74-silero-tts-discovery.md](wk-74-silero-tts-discovery.md) — prior
  blockers, both re-verified as of this document's date before this spike
  started.
- [companion-tts-voice-comparison.md](companion-tts-voice-comparison.md) —
  Piper baseline numbers this document compares against, and the
  `tasklist`-based RAM measurement method reused here.
- [local-tts-licensing.md](local-tts-licensing.md) — Piper's IPC-as-
  separate-program licensing reasoning, structurally the same shape reused
  for Silero's own GPL-free but NC-licensed situation (see the separate
  licensing notice this ticket adds).
- `https://www.python.org/ftp/python/3.12.10/python-3.12.10-embed-amd64.zip` —
  official Python embeddable distribution, fetched and used directly.
- `https://models.silero.ai/models/tts/ru/v5_5_ru.pt` — fetched directly,
  145,420,684 bytes confirmed via HTTP `Content-Length`.
- `apps/companion/src-tauri/src/tts.rs`, `scripts/companion-build-piper-runtime.ps1` —
  existing architecture this integration mirrors.
