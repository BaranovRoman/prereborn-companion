# Piper TTS quality audit (WK-77)

## Question

Two complaints about the shipped local Piper TTS (WK-75/WK-76): usernames are
pronounced badly, and the voice subjectively sounds muffled/"underwater".
Need to split this into (A) a playback/audio-pipeline bug, (B) a voice/model
quality problem, or (C) a text-normalization problem, and fix whichever is
actually confirmed - without adding a new TTS engine or changing the
subprocess-sidecar architecture (see
[local-tts-licensing.md](local-tts-licensing.md)).

## Current state

- Engine: self-built `OHF-Voice/piper1-gpl` v1.7.0 `libpiper` CLI
  (`piper_exe.exe`), spawned as a persistent subprocess
  (`apps/companion/src-tauri/src/tts.rs`), fed one line of text per
  utterance over stdin, writes one WAV file per utterance to
  `--output_dir`.
- Voice (before this audit): `ru_RU-denis-medium`.
- Transport: Rust reads the WAV file bytes, base64-encodes them
  (`synthesize_base64`), sends as a plain string over the Tauri IPC command.
  Frontend (`TwitchChatPage.tsx`) decodes base64 -> `Uint8Array` -> `Blob`
  (`audio/wav`) -> `new Audio(url).play()`. No `AudioContext`, no
  resampling, no manual sample-rate handling anywhere in this path.
- Text going into Piper: `prepareTtsText()` in `chat-model.ts` (WK-66) -
  message-type allowlist, repeated-character spam drop (8+ repeats of one
  char), URL -> "ссылка", whitespace collapse, length truncation, then
  `"{author}: {text}"` if `speakAuthor` is on. No username-specific
  handling existed before this audit - the raw Twitch display name was
  spoken literally.

## Findings

All of the below are measured, not assumed - see the reproduction steps at
the end of this section.

**1. Audio format.** Piper's WAV output is 22050Hz, mono, 32-bit IEEE float
(`audioFormat: 3`), confirmed by parsing the real WAV header byte-for-byte
and cross-checked against `ru_RU-denis-medium.onnx.json` /
`ru_RU-dmitri-medium.onnx.json` (`"audio": {"sample_rate": 22050}`). Neither
Russian voice on `piper-voices` ships a "high" quality tier - `medium` is
the ceiling for both `denis` and `dmitri` (confirmed via the HF API voice
listing: only a `medium/` subdirectory exists under each).

**2. A real but unrelated WAV bug.** This libpiper build (v1.7.0) never
patches the RIFF/`data` chunk size fields with the real byte count after
synthesis - every WAV it writes declares a fixed placeholder size (~2GB:
RIFF size `0x7ffff024`, data size `0x7ffff000`) regardless of actual
length. Confirmed via `--output_file` (a real, seekable file, not a pipe),
so this isn't a streaming-output limitation, it's the writer never seeking
back to fix the header. **This does not cause the muffled-audio complaint**:
a headless-Chromium test that replicates the exact frontend decode path
(base64 -> `atob` -> `Uint8Array` -> `Blob` -> `Audio.play()`) against the
real malformed-header files played every clip to completion with the
correct duration and byte-exact decoded length - Chromium's WAV decoder
clamps the bogus chunk size to the bytes actually present. Fixed anyway
(`fix_wav_chunk_sizes` in `tts.rs`, applied after reading Piper's output,
before base64-encoding) because it's a real RIFF-spec violation that only
works by luck of Chromium being lenient - a stricter consumer (different
browser engine, native player, re-encoding) would not be so forgiving.

**3. Playback pipeline is not the cause of the muffled complaint.** The
base64 round-trip is byte-exact (verified programmatically: decoded byte
length and content match the source file exactly). No resampling,
downsampling, or format conversion happens anywhere between Piper's stdout
file and the browser's audio decoder. If the saved WAV sounds muffled, the
app plays that exact muffled WAV - nothing in the pipeline degrades it
further.

**4. Voice quality is the dominant, measurable cause.** Synthesized 5
matched test phrases (normal message, question, emotional message,
username+message, numbers/English) through both `denis-medium` and
`dmitri-medium` using the real production libpiper build and default
inference params (`noise_scale=0.667`, `length_scale=1`, `noise_w=0.8` -
identical defaults in both voices' configs). FFT band-energy analysis of
matched phrases:

| Band | denis (normal) | dmitri (normal) | denis (emotional) | dmitri (emotional) |
|---|---|---|---|---|
| 0-1000Hz | 80.8% | 59.9% | 64.9% | 42.2% |
| 1000-2000Hz | 15.1% | 12.9% | 25.1% | 28.8% |
| 2000-4000Hz | 3.4% | 5.3% | 8.6% | 22.1% |
| 4000-6000Hz | 0.1% | 12.7% | 0.5% | 5.1% |
| 6000-8000Hz | 0.5% | 7.3% | 0.7% | 1.5% |
| 8000-11025Hz | 0.1% | 1.8% | 0.1% | 0.4% |

`denis` concentrates 65-81% of its energy below 1kHz with almost nothing
above 4kHz - an objectively dull/bassy spectral signature, consistent with
a "muffled"/"underwater" description. `dmitri` carries meaningfully more
energy through 2-8kHz on both phrases. This is a property of the two
different neural models (both `medium` tier, same sample rate), not a
config or pipeline difference.

**5. No prosody controls currently exposed, and no strong case found to add
any.** `piper_exe.exe --help` confirms `--noise_scale`, `--length_scale`,
`--noise_w` are available CLI flags; none are passed today (only
`--model`/`--config`/`--espeak_data`/`--output_dir`). These affect speaking
rate and generator noise/naturalness, not spectral brightness - they
wouldn't address the muffled complaint, and no other prosody knob (e.g.
sentence silence) exists in this CLI. Not adding UI controls for these per
the "normal default over many sliders" scope.

**6. Username normalization was entirely absent.** `prepareTtsText` spoke
`message.author` completely literally. `Roma_Romych_TV` was read as a raw
string with underscores, not as a name.

### Reproduction

Downloaded the real shipped runtime + voice from the latest GitHub Release
(`prereborn-v0.5.4`: `piper-runtime-win-x64.zip`,
`piper-voice-ru_RU-denis-medium.zip`) plus `ru_RU-dmitri-medium` from
`huggingface.co/rhasspy/piper-voices`, ran `piper_exe.exe` directly (same
binary Companion ships) against both voices with matched phrases, parsed
the resulting WAV headers/PCM with a small Node script, and replayed the
exact frontend decode+playback path in headless Chromium via Playwright.
No application code was exercised through the full Tauri app (not
necessary - the sidecar protocol is plain file I/O, independently
reproducible), but the real `synthesize_against_a_real_local_libpiper_build`
Rust integration test (`tts.rs`, normally `#[ignore]`d) was also run
against this same downloaded build and passes, exercising the actual
`Sidecar::spawn`/`synthesize` code path end-to-end including the new WAV
header fix.

## Options

1. **Switch default voice to `dmitri-medium`.** Same license class
   (MIT/CC0, `local-tts-licensing.md`), same sample rate/tier, zero
   architecture change - just which `.onnx` file ships. Directly addresses
   the measured spectral difference.
2. **Keep `denis`, try to EQ/brighten it in software** (e.g. a high-shelf
   filter on the PCM before playback). Rejected: masks a model-quality
   problem with a signal-processing hack, adds real complexity to a
   pipeline that's otherwise a dumb byte-passthrough, and a filter tuned by
   ear is more fragile than picking a voice that's actually brighter by
   design.
3. **Look for a third voice/quality tier.** Rejected: `piper-voices` has no
   `high` tier for Russian, and `ruslan`/`irina` are already ruled out on
   licensing grounds (`local-tts-licensing.md`).

## Recommendation

Switch the shipped default from `ru_RU-denis-medium` to
`ru_RU-dmitri-medium` (confirmed with the user after presenting the
spectral comparison and sample WAVs, per this audit's explicit
instruction not to auto-swap a subjective-quality default). Implemented in
`tts.rs` (`VOICE_NAME`, `VOICE_ASSET_URL`),
`scripts/companion-build-piper-runtime.ps1` (`$VoiceName`/`$VoiceHfPath`),
and the in-app license note (`TwitchChatPage.tsx`). Existing users will
download the ~60MB `dmitri` voice on next launch after upgrading; the old
`denis` files are left in place under `app_data_dir()/tts/voices/`
untouched (not cleaned up - same as any other stale-file-on-upgrade
question elsewhere in the app, not specific to this change).

Separately implemented regardless of the voice decision (both are
confirmed, narrowly-scoped fixes, not tied to which voice ships):

- Defensive WAV RIFF/data chunk-size fix in `tts.rs` (finding 2 above).
- Username + message speech-only normalization
  (`apps/companion/src/chat/tts-normalize.ts`): separators (`_`/`-`/`.`)
  become pauses, glued/separated `TV`/`TTV` suffixes are stripped, digit
  runs get word-boundaries, long id-like digit runs and unreadable
  consonant-only fragments are dropped, repeated characters collapse;
  message-side: emoji stripped, long laughter (`ха`/`ах`/`хи`/`ha`/`he`
  runs) shortened, excessive punctuation normalized, long non-spam repeats
  collapsed. Explicitly not a transliteration/NLP system - same script
  stays, only structural cleanup. Never touches what's rendered in the
  chat UI (`message.text`/`message.author` render directly from the
  unmodified `TwitchChatMessage`).

## Follow-up: Latin username pronunciation

The main audit fixed spectral "muffled" quality (voice choice) and basic
username structure (separators/suffixes/digits). A second, distinct problem
surfaced afterward on real messages: Latin-script usernames themselves are
mispronounced, independent of voice or structure - `romaromych` came out
sounding like "омаомыч" (leading /r/ dropped from both syllables), `imwisp`
like "имисп" (/w/ dropped entirely). Russian text through the same voice is
unaffected. Root cause: Piper's `ru_RU` voice phonemizes through
espeak-ng's `ru` module, which doesn't handle raw Latin input reliably -
confirmed by re-synthesizing both strings with the real production
`dmitri-medium` build: `romaromych` renders as **0.546s** of audio raw vs
**0.662s** transliterated to `ромаромыч` (~21% more audio recovered -
consistent with dropped syllables), `imwisp` **0.546s** raw vs **0.557s**
transliterated to `имвисп` (a smaller gap, consistent with just one dropped
letter, /w/).

**Fix**: transliterate Latin username fragments to a Cyrillic phonetic
approximation before they reach Piper, so espeak-ng's `ru` phonemizer never
sees raw Latin at all. Added to
`apps/companion/src/chat/tts-normalize.ts`, applied only to the username
(never message text, never the displayed name):

- A longest-match-first digraph table (`shch`→щ, `sh`→ш, `ch`→ч, `zh`→ж,
  `kh`→х, `ts`→ц, `ya`→я, `yu`→ю, `yo`→ё), then a full single-letter
  fallback covering every Latin letter, so any Latin run transliterates in
  full rather than partially.
- `w` maps the same as `v` ("soft" w) - Russian has no native /w/ phoneme,
  and mapping it to `в` is exactly what fixes the `imwisp` case (espeak-ng
  was dropping `w` outright rather than approximating it).
- Only Latin letter runs inside a token are rewritten; existing separator
  splitting, TV/TTV suffix stripping, digit-run/unreadable-fragment
  filtering, and repeat-collapsing all still run on the original Latin
  spelling first, in the same order as before - transliteration is the
  last per-token step, right before joining. This also means a token
  mixing scripts (rare) only has its Latin half rewritten.
- The "never go silent" fallback (used when normalization strips every
  token, e.g. a username that's entirely a platform suffix) also runs
  through transliteration now - previously it fell back to the raw
  original, which for an all-Latin username would hit the exact espeak-ng
  mangling this fix exists to avoid.
- Explicitly not academic transliteration or a general NLP system - no
  context-sensitive English pronunciation rules (e.g. `player` renders as
  "плаыер", not "плеер" - phonetically odd but deterministic and
  Piper-readable, not silently dropped). Good enough for "sounds like a
  name", not linguistically correct.

**Pronunciation overrides**: since automatic transliteration can't always
match how someone actually wants their name read (see `player` above),
added a minimal override list - `ChatSettings.usernamePronunciations`, a
single raw string of `username=spoken name` lines (case-insensitive on the
username), edited via a plain textarea in the TTS settings panel
(`TwitchChatPage.tsx`), not a dictionary editor. An override always wins
over automatic transliteration. Persisted through the same
`localStorage`-backed settings object the rest of chat settings already
uses - no new storage mechanism.

Verified via `pnpm test` (34/34 passing, 24 in `tts-normalize.test.ts`
covering both motivating examples, TV/TTV stripping before transliteration,
mixed Cyrillic/Latin, overrides, and the never-silent fallback) and
`pnpm build` (`tsc` + `vite build` clean). No Rust/engine/pipeline changes -
scoped entirely to the text handed to Piper, per instruction not to touch
the engine or audio pipeline.

## Follow-up

- The GPL-3.0 source-offer + MIT notice obligations noted in
  `local-tts-licensing.md` ("this obligation does not appear to be
  implemented anywhere in the app") are still outstanding, independent of
  this audit - the in-app note links to the upstream repos but doesn't
  reproduce license text. Worth its own small ticket.
- No cleanup exists for a voice left behind after a default switch
  (`denis`'s `.onnx`/`.onnx.json` will sit unused in `app_data_dir()` for
  anyone who already had it). Not urgent (~63MB), but worth folding into
  any future "clear TTS cache" affordance if one gets built.

## Sources

- Real shipped runtime/voice: GitHub Release `prereborn-v0.5.4`
  (`piper-runtime-win-x64.zip`, `piper-voice-ru_RU-denis-medium.zip`).
- `ru_RU-dmitri-medium.onnx`/`.onnx.json`:
  `huggingface.co/rhasspy/piper-voices/tree/main/ru/ru_RU/dmitri/medium`.
- Voice directory listing (quality tiers):
  `huggingface.co/api/models/rhasspy/piper-voices/tree/main/ru/ru_RU/{denis,dmitri}`.
- [local-tts-licensing.md](local-tts-licensing.md) - voice license
  verification (denis/dmitri both MIT/CC0).
