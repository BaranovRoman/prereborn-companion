# Piper TTS prototype findings (WK-74 follow-up)

Follow-up to
[wk-74-silero-tts-discovery.md](wk-74-silero-tts-discovery.md), which ruled
out Silero and proposed Piper as an alternative but explicitly hadn't
prototyped it. This is that prototype: real Windows numbers, plus two
licensing questions found along the way that need a legal read before any
implementation ticket starts.

No code was added to the app. Everything below was run standalone (Piper's
own Windows binary + a downloaded voice, invoked directly), outside the
repo, and deleted afterward.

## Setup

- Engine: `rhasspy/piper` release `2023.11.14-2`, Windows amd64 build
  (`piper.exe` + `onnxruntime.dll` + `piper_phonemize.dll` +
  `espeak-ng.dll` + `espeak-ng-data`). This is the **old, MIT-licensed**
  native build — see "Two engine lineages" below for why this one was used
  instead of the actively maintained fork.
- Voice: `ru_RU-denis-medium.onnx` (63.2 MB) from
  [piper-voices](https://huggingface.co/rhasspy/piper-voices/tree/main/ru/ru_RU/denis/medium) —
  picked specifically because its license is unambiguous (see below).
- Machine: the dev machine used for this session (Windows, no GPU used).
- Caveat: the old `piper.exe` predates the current maintained fork by ~2
  years. Numbers below are directionally solid (voice-load time and RTF are
  properties of the ONNX model + onnxruntime, not this particular CLI
  build) but should be re-measured against whatever engine build actually
  ships, once the licensing question is resolved.

## Performance numbers

| Scenario | Result |
|---|---|
| Voice load time (self-reported by piper, consistent across all runs) | **~215–220 ms** |
| Cold process, first-ever run after extracting the download (disk I/O + AV scan of a fresh 60 MB model, not yet OS-cached) | **~1.56 s** total |
| Fresh process, same phrase, OS file cache now warm | **~289 ms** total |
| One persistent process, 5 chat-length lines via stdin (the sidecar pattern) | **~298 ms** total → load once (~220 ms) + ~16 ms/line after that |
| One persistent process, 20 chat-length lines, peak RAM sampled throughout | **~2.39 s** total (~108 ms/line average), **real-time factor ≈ 0.05** (20× faster than real-time), **peak working set ≈ 147 MB** |
| Disk footprint | Engine (exe + all DLLs + **all-language** espeak-ng-data): **38 MB** (espeak-ng-data alone is 18 MB and is trimmable to just RU + a fallback language). One medium-quality voice: **~60 MB**. |

**Read on this:** performance is not a blocker anywhere. Held as a
persistent sidecar (load once when TTS is first enabled, then feed each
chat message a line at a time over stdin), per-message synthesis latency
for realistic chat-length phrases is comfortably sub-150 ms and RAM stays
under 150 MB even under a synthesis burst. This matches the discovery
doc's citation of Piper's own real-time-factor claims — confirmed
first-party on this machine, not just taken from the project's README.

One integration gotcha found in the process: `espeak-ng-data` file
loading breaks with `Illegal byte sequence` when the working directory (or
a parent directory, e.g. a Cyrillic Windows username) contains non-ASCII
characters. Given the target audience is Russian-speaking Windows users,
this is a real risk, not a theoretical one — worth explicit testing on a
machine with a Cyrillic username during implementation, and probably worth
forcing `--espeak_data` to an ASCII-only path (e.g. inside
`app_data_dir()`, matching the existing convention in
`storage/mod.rs`) rather than relying on cwd/relative resolution.

## Two engine lineages — and why licensing needs a real answer before implementing

This is the part that changed since the discovery doc, and the reason this
stopped at "prototype" rather than continuing into implementation.

### 1. The actively maintained engine (`OHF-Voice/piper1-gpl`, GPL-3.0) ships as a Python wheel, not a native binary

Checked its latest release (`v1.7.0`, 2026-08-15) directly via `gh release
view`: **all 6 asset files are Python wheels** (`piper_tts-1.7.0-*.whl`,
including `win_amd64`) plus a source tarball. No native `.exe`/CLI binary
was found anywhere in its release history. If this is still true by
implementation time, using the currently-maintained engine means bundling
a Python runtime — the same class of distribution problem the discovery
doc ruled Silero out for, just lighter weight (no PyTorch, "just"
CPython + onnxruntime + this package).

### 2. The Rust-native path (`piper-rs`) compiles and links actual GPL-3.0 C code into the binary

The discovery doc's optimistic read was "existing Rust bindings... no
Python runtime required at all." Tried this directly: `cargo add piper-rs
ort` resolves and downloads fine, but `cargo build` fails without
`libclang`/LLVM installed, because `piper-rs`'s phonemization dependency
(`espeak-rs` → `espeak-rs-sys`) **compiles `espeak-ng`'s actual C source
via bindgen and links it into the resulting binary** — this isn't a thin
wrapper, it's building the GPL-3.0 engine from source and statically
linking it. Using this crate in-process would embed GPL-3.0 code directly
into Companion's own binary, which is arguably a *harder* licensing
problem than the sidecar approach the discovery doc suggested specifically
to avoid this.

### 3. The old MIT-licensed native build (what this prototype actually used) ships `espeak-ng` as a separate DLL

`rhasspy/piper`'s last release (`2023.11.14-2`, confirmed MIT via `gh api
repos/rhasspy/piper/license`) bundles `espeak-ng.dll` as a **separate,
dynamically-loaded file** next to the MIT `piper.exe`, not linked into it.
This is the one structurally closest to "sidecar, not linked" — but it's
2+ years unmaintained (superseded by the GPL fork), so it's unclear
whether it should actually be the shipping choice or just the thing that
happened to be easiest to prototype with today.

### 4. Voice license is per-voice, not per-repository — and inconsistent even within the 4 candidate Russian voices

Checked each of WK-74's originally-scoped voices individually on
`huggingface.co/rhasspy/piper-voices` (the repo-level badge says "MIT" but
that is **not** reliable per-voice):

| Voice | Model license | Dataset license |
|---|---|---|
| `ru_RU-denis-medium` | MIT | CC0 |
| `ru_RU-ruslan-medium` | listed "mit" | **CC BY-NC-SA 4.0 — NonCommercial** |
| `ru_RU-irina-medium` | **"Unknown"** | **"Unknown"** (RHVoice-derived) |
| `ru_RU-dmitri-medium` | not checked yet | not checked yet |

`denis` is clean. `ruslan`'s top-line "mit" tag contradicts its own
NonCommercial dataset license — exactly the kind of thing that needs a
real legal read, not trust in a badge. `irina` is an outright blocker as
listed. This mirrors the Silero NC problem from the original discovery
doc, just voice-by-voice instead of model-wide.

## Research prompt (hand this to a licensing-focused agent/reviewer)

This is intentionally self-contained — includes the context needed
without this document.

> **Context:** PreReborn Companion is a closed-source Rust/Tauri Windows
> desktop app, distributed as a public installer, with an existing browser
> `SpeechSynthesis`-based TTS feature for reading Twitch chat aloud
> (WK-66). We're evaluating adding [Piper](https://github.com/rhasspy/piper)
> as a higher-quality local neural TTS alternative and need a licensing
> read before writing an implementation ticket. Performance is already
> validated (sub-150ms per-message synthesis, ~147MB peak RAM as a
> persistent sidecar) — this is purely about what's legally safe to ship.
>
> **Please research and answer:**
>
> 1. For each of these Piper Russian voices (medium quality, from
>    `huggingface.co/rhasspy/piper-voices/tree/main/ru/ru_RU`): `denis`,
>    `dmitri`, `irina`, `ruslan` — confirm the actual verified license of
>    both the model weights and the training dataset each was derived
>    from. Don't trust the repository-level license badge; check each
>    voice's own `MODEL_CARD`/metadata. Note: `denis` appears clean
>    (MIT model / CC0 dataset), `ruslan`'s dataset appears to be CC
>    BY-NC-SA 4.0 (NonCommercial) despite an "mit" model tag, and `irina`
>    is listed "Unknown" for both — please confirm or correct these, and
>    check `dmitri`. Are there other decent-quality Russian voices in the
>    Piper ecosystem worth considering with clearer licensing?
> 2. Is `OHF-Voice/piper1-gpl` (the actively maintained, GPL-3.0-licensed
>    fork of Piper) available as a native compiled binary/CLI anywhere —
>    official or community-built — or is Python packaging (`pip install
>    piper-tts`) now the only supported distribution? If Python-only,
>    what's the realistic bundled footprint (interpreter + onnxruntime +
>    this package) for a Windows installer, roughly?
> 3. Does spawning a GPL-3.0-licensed binary as a **child process** from a
>    closed-source app — and shipping that binary inside our own installer
>    — trigger GPL-3.0's copyleft/source-disclosure obligations for the
>    rest of our (unrelated) codebase? This applies to two concrete cases:
>    (a) the old MIT `rhasspy/piper` binary, which itself dynamically
>    loads a separate GPL-3.0 `espeak-ng.dll` at runtime, and (b) a
>    self-built `piper1-gpl` binary, if one exists or could be built.
>    Please cite authoritative sources (FSF FAQ, established legal
>    commentary on GPL + subprocess/IPC vs. linking) rather than general
>    assumptions about "sidecars are always safe."
> 4. Separately: the Rust crate `piper-rs` (`espeak-rs` →
>    `espeak-rs-sys`) compiles `espeak-ng`'s C source via `bindgen` and
>    links it directly into the consuming binary (confirmed: it requires
>    `libclang` to build from source). Does that change the analysis vs.
>    #3 — i.e., is in-process static linking of GPL-3.0 code meaningfully
>    riskier than the subprocess approach, as it intuitively seems?
> 5. **Bottom line:** is there a combination of (engine build) + (voice
>    model) + (integration architecture) that's safe to ship in a
>    commercial, closed-source Windows installer with no separate legal
>    agreement needed? If yes, name the exact combination. If no, what
>    would it take (e.g., contacting Silero/Piper maintainers, an
>    alternative engine, licensing a commercial voice) to get there?

## Recommendation

Don't open an implementation ticket for Piper yet. The performance case is
now solid and first-party-verified; the licensing case is not — and this
prototype surfaced a *harder* problem than the discovery doc anticipated
(the maintained engine went Python-only since piper-rs was last
plausible-looking, and the Rust-native path turns out to statically link
GPL C code). Get the research prompt above answered first; the answer
determines whether there's a shippable Piper path at all, and if so, which
exact engine+voice+architecture combination it is.
