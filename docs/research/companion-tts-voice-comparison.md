# Piper TTS voice comparison — denis / dmitri / irina / ruslan

Follow-up to [wk-77-tts-quality-audit.md](wk-77-tts-quality-audit.md), which
switched the shipped default from `ru_RU-denis-medium` to
`ru_RU-dmitri-medium` after finding denis measurably dull/bassy. New
feedback says `dmitri` still sounds unpleasant/muffled to some listeners, so
this is a fresh, controlled comparison across all 4 Russian voices Piper
ships (`piper-voices` has no "high" tier for Russian — `medium` is the
ceiling for all four): `denis`, `dmitri`, `irina`, `ruslan`.

**This document does not pick a voice.** It exists to produce comparable
measured data and matched audio samples for a human to listen to and
decide — see "No recommendation" at the end.

## Setup

- Engine: the real shipped runtime, downloaded from the latest GitHub
  Release (`piper-runtime-win-x64.zip` —
  `piper_exe.exe` + `piper.dll` + `onnxruntime.dll` +
  `onnxruntime_providers_shared.dll` + `espeak-ng-data/`), extracted
  standalone. Same binary Companion ships, invoked the same way
  (`--model`, `--config`, `--espeak_data`, `--output_dir`), fed one line of
  text per utterance over stdin, reading the absolute WAV path Piper prints
  to stdout per line — the exact protocol `Sidecar::spawn`/`synthesize` in
  `apps/companion/src-tauri/src/tts.rs` uses, not directory polling.
- Voices: `.onnx` + `.onnx.json` pairs downloaded directly from
  `huggingface.co/rhasspy/piper-voices/resolve/main/ru/ru_RU/<voice>/medium/`
  for `denis`, `dmitri`, `irina`, `ruslan`. All four report
  `sample_rate: 22050` and identical inference defaults
  (`noise_scale=0.667`, `length_scale=1`, `noise_w=0.8`) in their
  `.onnx.json` — confirmed by reading each file, not assumed.
- Machine: this dev machine (Windows 11, Cyrillic username `Рома`, no GPU
  used).
- No application code was touched. Everything below ran standalone, outside
  the repo, in a scratch directory that was not committed.

### Cyrillic-username path issue — hit and worked around

`tts.rs`'s `to_short_path` comment documents a known bug: espeak-ng's file
loader throws `Illegal byte sequence` when any part of the `--espeak_data`
path contains non-ASCII bytes, which a Cyrillic Windows username (this
machine's `Рома`) guarantees. This was reproduced directly before applying
the fix, not just assumed:

```
$ echo "тест" | piper_exe.exe --model ... --espeak_data "C:\Users\Рома\...\espeak-ng-data" --output_dir ...
Error processing file 'C:/Users/????/AppData/Local/Temp/.../espeak-ng-data\phontab': Illegal byte sequence.
```

Fixed the same way `tts.rs` fixes it in production: resolved every path
handed to `piper_exe.exe` (exe, model, config, espeak-ng-data dir, per-voice
output dir) to its legacy 8.3 short-path form first (`C:\Users\78FC~1\...`,
pure ASCII), via `GetShortPathNameW`-equivalent short-path resolution
(`cmd /c for %A in ("path") do @echo %~sA`). 8.3 short-name generation was
confirmed enabled on this machine's `C:` volume (short paths resolved
successfully for every file/dir needed). With short paths, all 4 voices
loaded and synthesized without error.

### Phrase set (identical across all 4 voices)

1. `го дальше, потом фарм` — short Twitch-style message
2. `слушай, я реально не понимаю зачем они вообще решили пушить мид на
   двадцатой минуте, там же не было ни одного крипа под контролем` — long
   conversational message
3. `а тебе не кажется что саппорт слишком поздно купил дагон?` — question
4. `ромаромыч: го фармить трайхерд` — author-prefixed, exactly the
   `"{author}: {text}"` shape `prepareTtsText` in
   `apps/companion/src/chat/chat-model.ts` produces
5. `го пуш на mid, там нет vision` — mixed Cyrillic/Latin
6. `ееее наконец-то, красавчик, вообще шикарно сыграл!!!` — emotional/casual

Each voice ran as one persistent `piper_exe.exe` process fed all 6 phrases
in order over stdin, matching the real sidecar's one-process-per-session
lifetime.

## Results

All 24 (voice × phrase) syntheses succeeded — no timeouts, no crashes, no
`Illegal byte sequence` errors once short paths were applied.

Per-call latency ("elapsed") is the wall-clock time from writing the stdin
line to receiving Piper's stdout completion line for that exact call — the
same signal `Sidecar::synthesize` waits on. "Cold" is call 1 for that
process (includes one-time model load); "warm avg" is the mean of calls
2–6. RTF = elapsed ms ÷ output WAV duration ms (lower is faster than
real-time).

| Voice | Cold (call 1) | Avg warm latency | Avg warm RTF | Avg WAV duration (all 6) | Model size on disk | License verdict |
|---|---|---|---|---|---|---|
| `denis` | 991.5 ms | 320.8 ms | 0.0837 | 3434.6 ms | 60.27 MB | **A — clean** (MIT model / CC0 dataset) |
| `dmitri` | 899.6 ms | 268.8 ms | 0.0841 | 2877.3 ms | 60.27 MB | **A — clean** (MIT model / CC0 dataset) |
| `irina` | 947.3 ms | 366.7 ms | 0.0811 | 4075.1 ms | 60.27 MB | **C — reject (uncertain)**: license "Unknown" for both model and dataset |
| `ruslan` | 906.0 ms | 302.1 ms | 0.0826 | 3274.0 ms | 60.27 MB | **B — reject (commercial)**: dataset CC BY-NC-SA 4.0 (NonCommercial), despite a misleading "mit" model tag |

License verdicts are cited from
[local-tts-licensing.md](local-tts-licensing.md), not re-derived here (see
"Licensing spot-check" below for what was re-verified this pass).

Average WAV duration differs across voices because each voice speaks the
same text at its own natural pace/prosody — that's a voice property, not a
performance difference. RTF is the fair cross-voice performance comparison,
and all 4 land in the same narrow band (~0.081–0.084, i.e. roughly 12×
faster than real-time once warm) — **voice choice has no meaningful
performance cost among these four**, only quality/licensing differs.

Cold-start (call 1, ~900–990 ms across all voices) is dominated by model
load, not phrase 1's text length — consistent with the ~215–220 ms voice
-load figure measured in
[wk-74-piper-prototype-findings.md](wk-74-piper-prototype-findings.md) plus
this run's additional first-call JIT/disk-cache overhead on a cold process.

### Peak RAM

Sampled via `tasklist` polling every 150 ms during `denis`'s full 6-phrase
run (one voice only, per the task's own allowance — all 4 are the same
63 MB-class ONNX architecture, so peak RAM is not expected to vary
meaningfully by voice): **peak working set ≈ 206 MB**. Not re-sampled for
the other 3 voices.

### Per-phrase breakdown

Elapsed (ms) / WAV duration (ms) / RTF, per voice per phrase:

| Phrase | denis | dmitri | irina | ruslan |
|---|---|---|---|---|
| 1-short (cold) | 991.5 / 1579.0 / 0.628 | 899.6 / 1300.3 / 0.692 | 947.3 / 1938.9 / 0.489 | 906.0 / 1370.0 / 0.661 |
| 2-long | 678.1 / 7906.4 / 0.086 | 579.4 / 6826.7 / 0.085 | 773.3 / 9438.9 / 0.082 | 594.5 / 7093.7 / 0.084 |
| 3-question | 294.7 / 3529.4 / 0.084 | 239.8 / 2856.1 / 0.084 | 311.9 / 3796.5 / 0.082 | 287.3 / 3448.2 / 0.083 |
| 4-username | 187.2 / 2322.0 / 0.081 | 138.6 / 1660.2 / 0.084 | 207.9 / 2612.2 / 0.080 | 171.5 / 2124.6 / 0.081 |
| 5-mixed-script | 157.4 / 1869.2 / 0.084 | 132.8 / 1555.7 / 0.085 | 228.7 / 2867.7 / 0.080 | 141.3 / 1660.2 / 0.085 |
| 6-emotional | 286.5 / 3401.7 / 0.084 | 253.5 / 3065.0 / 0.083 | 311.9 / 3796.5 / 0.082 | 316.2 / 3947.4 / 0.080 |

Row 1's RTF is inflated by model-load time riding along with the first
call, same as the "cold" column above — not representative of steady-state
performance.

## FFT band-energy analysis (nice-to-have, extends wk-77's method)

Same idea as wk-77's spectral comparison, extended to all 4 voices: read
each WAV's raw 32-bit float PCM, apply a Hann window, run an FFT over the
whole clip, and bucket magnitude-squared energy into the same 6 bands
wk-77 used. Run on phrase 2 (long/"normal") and phrase 6 ("emotional") for
every voice — wk-77's own script/window choice isn't preserved verbatim
(a Hann window was added here to reduce spectral leakage; wk-77's text
doesn't specify whether it used one), so treat this as a fresh, independently
re-derived measurement that happens to use the same band boundaries and
phrase categories, not a byte-for-byte reproduction of wk-77's numbers.

| Voice | Phrase | 0–1kHz | 1–2kHz | 2–4kHz | 4–6kHz | 6–8kHz | 8–11kHz |
|---|---|---|---|---|---|---|---|
| denis | normal | 91.7% | 6.0% | 2.2% | 0.07% | 0.03% | 0.001% |
| denis | emotional | 92.3% | 6.6% | 1.0% | 0.05% | 0.03% | 0.001% |
| dmitri | normal | 77.2% | 6.3% | 8.8% | 7.1% | 0.6% | 0.2% |
| dmitri | emotional | 69.4% | 18.1% | 6.8% | 4.1% | 1.1% | 0.5% |
| irina | normal | 89.3% | 5.9% | 2.7% | 0.7% | 1.1% | 0.4% |
| irina | emotional | 79.6% | 14.9% | 2.9% | 0.8% | 1.2% | 0.7% |
| ruslan | normal | 87.8% | 3.9% | 6.3% | 1.9% | 0.1% | 0.03% |
| ruslan | emotional | 78.2% | 8.4% | 8.8% | 2.1% | 1.8% | 0.7% |

Re-confirms wk-77's directional finding with this run's own numbers:
`denis` is the most extreme outlier — 91–92% of its energy sits below 1kHz
with almost nothing above 2kHz on either phrase, an objectively duller
spectral profile than the other three. `dmitri` carries the most energy in
the 2–8kHz range of any voice measured here (up to ~16% combined on the
emotional phrase). `irina` and `ruslan` both sit between denis and dmitri —
neither as bass-heavy as denis nor as broadband as dmitri. This is
spectral-shape data only; it is not a substitute for actually listening
(see below), and higher high-frequency energy does not by itself mean
"sounds better" — it's the same objective signal wk-77 used to explain a
"muffled" complaint, offered here for all 4 voices rather than just 2.

## Licensing spot-check

Per the task, licensing is already resolved in
[local-tts-licensing.md](local-tts-licensing.md) and was not re-derived —
only spot-checked for drift. Fetched each voice's own `MODEL_CARD`
directly (`huggingface.co/rhasspy/piper-voices/raw/main/ru/ru_RU/<voice>/medium/MODEL_CARD`
— note: no `.md` extension on the actual file, unlike the raw-URL guess in
the task prompt) and confirmed dataset license/URL match the existing
doc exactly for all 4 voices, no drift found:

| Voice | Dataset license (MODEL_CARD, fetched this pass) | Matches existing doc? |
|---|---|---|
| `denis` | CC0 | Yes |
| `dmitri` | CC0 | Yes |
| `irina` | Unknown | Yes |
| `ruslan` | `creativecommons.org/licenses/by-nc-sa/4.0/` | Yes |

No change since `local-tts-licensing.md` was written. `irina` and `ruslan`
remain not usable in a commercial build under that doc's analysis
regardless of any quality finding here.

## WAV artifacts

All 24 synthesized WAVs were saved for manual listening, **outside this
repo** (per the task's constraint — nothing binary risks being committed):

```
C:\Users\Рома\Documents\prereborn-tts-voice-comparison\
  denis\    1-short.wav  2-long.wav  3-question.wav  4-username.wav  5-mixed-script.wav  6-emotional.wav
  dmitri\   1-short.wav  2-long.wav  3-question.wav  4-username.wav  5-mixed-script.wav  6-emotional.wav
  irina\    1-short.wav  2-long.wav  3-question.wav  4-username.wav  5-mixed-script.wav  6-emotional.wav
  ruslan\   1-short.wav  2-long.wav  3-question.wav  4-username.wav  5-mixed-script.wav  6-emotional.wav
```

Each file is named by phrase number, matching the phrase list above, so
`denis\4-username.wav` and `irina\4-username.wav` are directly comparable
(same text, different voice).

## Reproduction

1. Download the engine: `https://github.com/BaranovRoman/prereborn-companion/releases/latest/download/piper-runtime-win-x64.zip`,
   extract anywhere.
2. Download each voice's `.onnx` + `.onnx.json` from
   `https://huggingface.co/rhasspy/piper-voices/resolve/main/ru/ru_RU/<voice>/medium/ru_RU-<voice>-medium.onnx[.json]`
   for `<voice>` in `denis`, `dmitri`, `irina`, `ruslan`.
3. If any path involved contains non-ASCII characters (e.g. a Cyrillic
   Windows username), resolve every path passed to `piper_exe.exe` to its
   8.3 short-path form first (`cmd /c for %A in ("long\path") do @echo %~sA`,
   or the `GetShortPathNameW` call `to_short_path` in `tts.rs` uses) —
   otherwise espeak-ng fails with `Illegal byte sequence` on
   `--espeak_data`.
4. Spawn `piper_exe.exe --model <voice>.onnx --config <voice>.onnx.json
   --espeak_data <espeak-ng-data dir> --output_dir <dir>` as one persistent
   process per voice, write each phrase as one line to stdin, and read the
   absolute WAV path Piper prints back on stdout per line — do not poll
   `--output_dir` for "the newest file" (see `tts.rs`'s WK-79 comment for
   why that's a real, previously-shipped bug, not a hypothetical one).
5. Time from writing the stdin line to receiving the matching stdout line
   for per-call latency; compute WAV duration as
   `(file_bytes.len() - 44) / 4 / 22050` seconds — this libpiper build
   never patches the RIFF/`data` chunk-size header fields (confirmed in
   wk-77), so the declared chunk size cannot be trusted, only the actual
   byte count.

The scratch working directory and its Node.js measurement scripts used to
produce the numbers above were not kept as part of this deliverable (they
lived under a temp scratch path, not this repo, and are not referenced by
anything committed here) — the WAV artifacts and the numbers in this
document are the durable output of that run.

## No recommendation

This document deliberately does not declare a winner. `denis` is the
clearest spectral outlier (duller/bassier than the other three on this
run's own numbers, consistent with wk-77), and `irina`/`ruslan` carry
licensing blockers that rule them out for a commercial build regardless of
how they sound — but which voice actually *sounds best* to a listener is a
subjective judgment this document isn't making. Listen to the matched WAV
pairs in `C:\Users\Рома\Documents\prereborn-tts-voice-comparison\` and
decide from there.

## Sources

- Engine: `https://github.com/BaranovRoman/prereborn-companion/releases/latest/download/piper-runtime-win-x64.zip`
  (real shipped runtime, `piper_exe.exe` v1.7.0-class build already used in
  production).
- Voices: `huggingface.co/rhasspy/piper-voices/tree/main/ru/ru_RU/{denis,dmitri,irina,ruslan}/medium`
  (`.onnx`, `.onnx.json`, `MODEL_CARD`, fetched directly this pass).
- [wk-77-tts-quality-audit.md](wk-77-tts-quality-audit.md) — prior
  denis/dmitri spectral comparison and methodology this document extends.
- [local-tts-licensing.md](local-tts-licensing.md) — per-voice license
  verdicts, cited not re-derived (spot-checked for drift this pass, none
  found).
- [wk-74-piper-prototype-findings.md](wk-74-piper-prototype-findings.md) —
  prior cold-load/RAM baseline this run's cold-start numbers are consistent
  with.
- `apps/companion/src-tauri/src/tts.rs` — real production sidecar protocol
  (`Sidecar::spawn`/`synthesize`, `to_short_path`, `fix_wav_chunk_sizes`)
  this comparison's harness mirrors.
