# Silero TTS for Twitch chat — discovery (WK-74)

## Goal

WK-74 asked for a higher-quality local TTS engine (Silero `v5_5_ru`) for
Twitch chat in Companion, alongside the existing system-TTS feature from
WK-66, fully offline and without a mandatory heavy runtime bundled into the
installer. The ticket itself specifies an off-ramp: if Silero turns out
impractical to distribute inside Tauri, stop after discovery, record the
findings, and propose a minimal alternative instead of forcing the heavy
solution through. This document is that stop point.

## Existing WK-66 architecture (baseline)

TTS today is 100% frontend — there is no Rust-side TTS, audio playback, or
ML/ONNX dependency anywhere in `apps/companion/src-tauri` (confirmed via
`Cargo.toml`/`Cargo.lock`: no `ort`, no `tokio` in app code, no audio crate).

- **Synthesis**: `apps/companion/src/components/TwitchChatPage.tsx` —
  `drainTts()` builds a `SpeechSynthesisUtterance`, hardcodes
  `utterance.lang = "ru-RU"`, and calls the browser's
  `window.speechSynthesis.speak()`. No voice enumeration/selection exists.
- **Queue**: `apps/companion/src/chat/chat-model.ts` — `BoundedTtsQueue`
  (default `limit = 3`, drop-oldest on overflow), `maxAgeMs = 15_000`
  staleness eviction in `takeNext()`, dedup via a capped `Set<string>` of
  seen message ids.
- **Stop/disable**: both the "Stop" button and toggling TTS off call
  `queue.current.clear()` + `window.speechSynthesis.cancel()` +
  reset the `speaking` flag — immediate, synchronous, no async race.
- **Persistence**: `localStorage` key `companion-twitch-chat-settings-v1`
  (not a Tauri store). Fields today: `soundEnabled`, `ttsEnabled`,
  `speakAuthor`, `maxLength` — no voice/engine/speed fields yet.
- **Text filtering**: `prepareTtsText()` in `chat-model.ts` — message-type
  allowlist, repeated-char spam filter (8+ identical chars drops the
  message), URL replacement with the literal word "ссылка", length
  truncation with an ellipsis.
- **Settings UI**: a single `<aside className="chat-settings">` block in
  `TwitchChatPage.tsx`, controls disabled (not hidden) via an `is-disabled`
  class when TTS is off.

This is the surface a Silero (or any new) engine would need to plug into.

## Why Silero v5_5_ru doesn't fit

Two independent blockers, either of which is sufficient to stop here.

### 1. Distribution format is Python/PyTorch-only

`v5_5_ru` is published as a single `torch.package` file
(`https://models.silero.ai/models/tts/ru/v5_5_ru.pt`,
[models.yml](https://github.com/snakers4/silero-models/blob/master/models.yml)),
loaded in Python via `torch.package.PackageImporter` (or the
`torch.hub`/`pip install silero` wrappers). `torch.package` is not plain
TorchScript — it can bundle arbitrary pickled Python objects and source
code, not just a scripted tensor graph. Practical consequence:

- **Rust's `ort` crate** only loads ONNX models. No official ONNX export of
  this model exists (confirmed: no ONNX/C++ inference path is mentioned
  anywhere in the model repo or in Silero's own v5 announcement).
- **`tch-rs`/libtorch** only loads plain scripted/traced TorchScript
  modules with a tensor-in/tensor-out `forward()`. A `torch.package` that
  embeds real Python objects is not guaranteed to reduce to that shape, and
  no working example of running Silero this way was found.
- The only confirmed way to run the actual model is a real Python
  interpreter with PyTorch installed. That is precisely the dependency the
  ticket said not to drag into the installer without an evaluation — and,
  per Silero's own v5 announcement ([Habr, RU](https://habr.com/en/articles/961930/)),
  the model itself is already ~140MB, on top of a Python + PyTorch CPU
  runtime that typically adds another 150–250MB+ and real interpreter/import
  startup overhead. For an app whose Rust backend today has zero ML/Python
  footprint, that's a step-change in installer size and startup cost for
  one optional feature.

For reference, the same announcement gives real CPU throughput once the
model *is* loaded in Python: single-thread real-time factor 37–42×,
four-thread 100–110× (synthesized-audio-seconds per wall-clock second) — so
raw synthesis speed is not the problem; getting the model running outside
Python at all is. Confirmed v5 speakers: `aidar`, `baya`, `kseniya`,
`xenia`, `eugene` — the ticket's named voice list is accurate for this
model, for what it's worth.

No cold-start/warm-latency/RAM/CPU measurements on Windows are included
here, because producing them would require first standing up the Python
sidecar this discovery is arguing against — i.e., doing the heavy thing to
find out if the heavy thing is worth doing. That inversion is the signal to
stop rather than the missing piece to fill in.

### 2. License is non-commercial

`snakers4/silero-models` is licensed
[CC BY-NC-SA 4.0](https://github.com/snakers4/silero-models/blob/master/LICENSE) —
"NonCommercial purposes only," ShareAlike on derivatives. The v5
announcement doesn't carve out an exception for this model. This is a
blocker independent of the technical path chosen, and would need Silero's
Enterprise Edition (a commercial agreement with Silero directly) to clear
for any commercial use of Companion.

## Proposed alternative: Piper TTS

[Piper](https://github.com/rhasspy/piper) is a local neural TTS built
specifically for this embedding scenario — offline, small per-voice models,
designed to be driven from non-Python hosts.

- **Format**: voices are plain ONNX files, directly loadable via Rust's
  `ort` crate. Existing Rust bindings already exist on crates.io
  (`piper-rs`, `piper1-rs`) — no Python runtime required at all, which
  resolves blocker #1 outright.
- **Size/performance**: medium-quality voices are a single `.onnx` file,
  roughly 60MB, with real-time CPU synthesis even on constrained hardware
  (Raspberry Pi-class) per the project's own claims — comfortably within
  budget for short Twitch chat messages on any Windows desktop.
- **Russian voices available today** (via
  [piper-voices](https://huggingface.co/rhasspy/piper-voices/tree/main/ru/ru_RU)):
  `ru_RU-denis`, `ru_RU-dmitri`, `ru_RU-irina`, `ru_RU-ruslan` (medium
  quality). These are **different names** from Silero's
  aidar/baya/kseniya/xenia/eugene — WK-74's named-voice requirement would
  need to be re-scoped to Piper's actual voice set if this path is taken.
- **Licensing needs a real check before adoption**: the original
  `rhasspy/piper` engine is MIT-licensed but the repo points at
  `OHF-Voice/piper1-gpl` as the actively maintained successor, which is
  **GPL-3.0** for the engine code (voice model weights are typically
  licensed separately from the engine, but that needs confirming per
  voice). GPL-3.0 statically linked into a closed-source Rust binary is a
  real problem; running Piper as an **external sidecar process**
  communicating over stdio/IPC — rather than linking a GPL crate directly —
  is the standard mitigation and fits Tauri's supported (currently unused
  in this app) `externalBin`/sidecar bundling mechanism. This still needs a
  firm license read, not an assumption, before committing.
- **Model lifecycle** carries over unchanged from WK-74's original spec:
  download on first opt-in, cache under `app_data_dir()` (the existing
  convention in `apps/companion/src-tauri/src/storage/mod.rs`), corruption
  check, safe delete, bounded disk usage.

### Recommendation

Piper looks like a substantially better technical fit (ONNX-native, no
Python runtime, existing Rust bindings, permissive-leaning licensing if run
as a sidecar), but it hasn't been prototyped. Before committing to it:

- Get real Windows measurements (cold start, warm synthesis latency for a
  short phrase, RAM, CPU) the same way WK-74 asked for Silero.
- Nail down the actual license terms for whichever Piper voices/engine
  build gets used, and confirm the sidecar-process approach actually
  avoids the GPL linking concern for this app's distribution model.

This is scoped as a **new follow-up ticket**, not folded into WK-74, since
it's a different engine with different voices and its own risk profile.

## Sources

- [snakers4/silero-models — models.yml](https://github.com/snakers4/silero-models/blob/master/models.yml)
- [snakers4/silero-models — LICENSE](https://github.com/snakers4/silero-models/blob/master/LICENSE)
- [Мы опубликовали silero-tts v5 на русском языке (Habr, official v5 announcement)](https://habr.com/en/articles/961930/)
- [rhasspy/piper](https://github.com/rhasspy/piper)
- [OHF-Voice/piper1-gpl](https://github.com/OHF-Voice/piper1-gpl)
- [rhasspy/piper-voices — ru/ru_RU on Hugging Face](https://huggingface.co/rhasspy/piper-voices/tree/main/ru/ru_RU)
- [piper-rs on crates.io](https://crates.io/crates/piper-rs)
- [piper1-rs on crates.io](https://crates.io/crates/piper1-rs)
