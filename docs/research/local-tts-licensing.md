# Local TTS licensing — decision (WK-74 follow-up)

Follow-up to
[wk-74-piper-prototype-findings.md](wk-74-piper-prototype-findings.md),
which validated Piper's performance but stopped short of a shipping
decision pending a real licensing read. This is that read: four concrete
integration paths classified against actual license text and FSF's own
published position on GPL + subprocesses, plus one alternative engine
considered. No application code was touched — this is a documentation-only
follow-up, same as its predecessor.

## The one question that decides three of the four paths

Piper's phonemizer dependency is `espeak-ng`, GPL-3.0, confirmed plain
(`gh api repos/espeak-ng/espeak-ng/contents/COPYING` — full GPLv3 text,
no linking exception, no classpath-style carve-out; the only other license
files in that repo, `COPYING.APACHE`/`COPYING.BSD2`/`COPYING.UCD`, cover
unrelated bundled third-party code, not the engine itself). So every path
below reduces to one of two licensing questions:

**Q1 — static/in-process linking:** does compiling GPL-3.0 C code
directly into Companion's own binary make Companion a combined work under
GPL-3.0? The GNU GPL FAQ answers this without ambiguity:

> "Does the GPL have different requirements for statically vs dynamically
> linked modules with a covered work? — No. Linking a GPL covered work
> statically or dynamically with other modules is making a combined work
> based on the GPL covered work. Thus, the terms and conditions of the GNU
> General Public License cover the whole combination."
> — [GNU GPL FAQ](https://www.gnu.org/licenses/gpl-faq.html)

Unambiguous. **B: REJECT** for anything that links GPL code into
Companion's own binary.

**Q2 — subprocess/IPC:** does spawning a separately-distributed GPL-3.0
binary as a child process, and talking to it over stdin/stdout, make
Companion a combined work? The same FAQ, on aggregates vs. combined
programs:

> "We believe that a proper criterion depends both on the mechanism of
> communication (exec, pipes, rpc, function calls within a shared address
> space, etc.) and the semantics of the communication (what kinds of
> information are interchanged) ... pipes, sockets and command-line
> arguments are communication mechanisms normally used between two
> separate programs. So when they are used for communication, the modules
> normally are separate programs. But if the semantics of the
> communication are intimate enough, exchanging complex internal data
> structures, that too could be a basis to consider the two parts as
> combined into a larger program."
> — [GNU GPL FAQ](https://www.gnu.org/licenses/gpl-faq.html)

What crosses the process boundary for Piper-as-sidecar is plain UTF-8 text
lines in, WAV/raw PCM bytes out — no shared memory, no shared data
structures, no function-level API. That's the least "intimate" shape of
IPC there is, structurally identical to how any proprietary app shells out
to `ffmpeg`, `imagemagick`, `pandoc`, or `ghostscript` (all GPL/LGPL) —
extremely well-established, widely-shipped commercial practice (e.g.
Audacity deliberately loads FFmpeg as a runtime plugin rather than linking
it, specifically to stay on the "separate program" side of this line).
FSF explicitly frames this as ultimately a judicial question, not a bright
line written into the license text — so this is FSF's own strong opinion
plus near-universal industry practice, not settled case law. Given how
one-sided the practice is and how clearly non-intimate this specific IPC
is, this is classified **A: ACCEPTABLE**, not C — with real obligations
attached (below), not a free pass.

## Path-by-path classification

### 1. Old `rhasspy/piper.exe` (MIT) + separate `espeak-ng.dll` + `ru_RU-denis-medium`

**A — ACCEPTABLE CANDIDATE.** Already the exact combination prototyped in
the previous doc.

- Engine: `piper.exe` is MIT (confirmed: `gh api repos/rhasspy/piper/license`
  → `MIT`). It does not statically link `espeak-ng` — the Windows release
  bundles `espeak-ng.dll` as a **separate file**, loaded at runtime, not
  compiled into `piper.exe`.
- Voice: `ru_RU-denis-medium` — model MIT, dataset CC0 (public domain),
  confirmed via its own `MODEL_CARD`, not the repo-level badge.
- Obligations that still apply (this does **not** mean zero-obligation):
  - `espeak-ng.dll`, as a GPL-3.0 component you are redistributing inside
    your installer, must remain accompanied by its GPL-3.0 license text
    and either its source or a written offer for it (standard GPL
    source-availability duty for the *redistributed GPL component itself*
    — this does not extend to Companion's own source).
  - `piper.exe`'s MIT license notice must be retained/reproduced somewhere
    in the app (e.g. an about/licenses screen) — standard MIT term.
  - The voice model's MIT notice likewise should be retained for
    completeness, though CC0 dataset provenance needs no attribution.
- Caveat: this exact binary is unmaintained since 2023-11-14, superseded
  by the GPL fork. Fine for a prototype; a maintenance concern for a
  shipped product (see recommendation).

### 2. Self-built `OHF-Voice/piper1-gpl` executable, used strictly as a subprocess, + a commercially usable Russian voice

**A — ACCEPTABLE CANDIDATE**, same Q2 reasoning as path 1, once you
accept that Q2 conclusion. Verified buildability directly, not assumed:

- `piper1-gpl`'s own `libpiper/CMakeLists.txt` + `libpiper/README.md`
  confirm it's a real C/C++ shared library (`libpiper`) with a documented
  C API (`piper_create`/`piper_synthesize_*`), built via CMake — **not**
  Python-only. Its own README states building it "will automatically
  download/build espeak-ng as well as download shared libraries for the
  onnxruntime." The top-level repo license is GPL-3.0
  (`gh api repos/OHF-Voice/piper1-gpl/license` → `GPL-3.0`), and
  `CMakeLists.txt` confirms `espeakbridge` statically links espeak-ng —
  self-consistent, since the whole repo is already GPL-3.0.
- So: no official standalone CLI ships (only Python wheels in Releases),
  but a small first-party `main()` linking `libpiper` + calling
  `piper_synthesize_start`/`piper_synthesize_next` is a straightforward
  build from documented, maintained upstream source — the resulting
  binary is GPL-3.0 (it links a GPL-3.0 library), which is exactly the
  same shape as path 1's `piper.exe` + `espeak-ng.dll`: a self-contained
  GPL-3.0 program, run as Companion's subprocess.
- Voice: same requirement as path 1 — pick a per-voice-verified clean
  license (`denis`/`dmitri`, both MIT model + CC0 dataset — see table
  below).
- Obligations: same class as path 1 (GPL source-offer + license text for
  the redistributed GPL binary, not for Companion). This path additionally
  means **you own the build** (own CMake/CI step, own Windows toolchain
  requirement) rather than downloading a prebuilt artifact — an
  engineering cost, not a licensing one.

### 3. `piper-rs` linked into the Companion binary

**B — REJECT.** Directly confirmed in the prior prototype: `piper-rs`'s
phonemization dependency (`espeak-rs` → `espeak-rs-sys`) compiles
`espeak-ng`'s actual C source via `bindgen` and links it into the
consuming binary (`cargo build` fails without `libclang` specifically
because it's compiling espeak-ng from source at build time). This is Q1,
not Q2 — the FAQ answer above is unambiguous: statically or dynamically
linking a GPL-3.0 module into Companion's own executable makes Companion
"cover[ed]" by GPL-3.0 in its entirety. Shipping a closed-source Companion
binary built this way is a direct GPL-3.0 violation risk. Do not use this
crate in-process, regardless of which voice it's paired with.

### 4. Maintained Piper Python sidecar + commercially usable Russian voice

**A — ACCEPTABLE**, identical Q2 reasoning to paths 1–2 — running
`python -m piper ...` as a spawned child process, talking over the same
plain stdin/stdout text-and-audio interface, is the same "separate
program" shape regardless of what runtime lives inside that process.
Licensing is not the reason to avoid this path.

- What *does* argue against it: distribution footprint and complexity.
  Bundling a Python interpreter + `onnxruntime` + the `piper-tts` wheel
  into a Windows installer is a materially heavier, more fragile
  dependency than a single native binary — the same class of problem the
  original Silero discovery doc ruled out, just lighter (no PyTorch).
  Given path 2 delivers the identical license position with a single
  native `.exe` and no interpreter to bundle/version/patch, there's no
  reason to prefer this path over path 2 for a native Windows app.

## Voice licenses, verified per-voice (not per-repository)

The `piper-voices` repo-level badge says "MIT" — not reliable per voice,
confirmed by checking each `MODEL_CARD` directly:

| Voice | Model license | Dataset license | Verdict |
|---|---|---|---|
| `ru_RU-denis-medium` | MIT | CC0 | **A** — clean |
| `ru_RU-dmitri-medium` | MIT | CC0 | **A** — clean |
| `ru_RU-ruslan-medium` | listed "mit" (misleading) | **CC BY-NC-SA 4.0** | **B — REJECT.** The license is explicit: "NonCommercial" per Creative Commons' own definition forbids use "primarily intended for or directed toward commercial advantage," and ShareAlike would additionally force any derivative (the trained voice model is one) under the same NC terms. The top-line "mit" model tag does not override the dataset's actual license — the model is a derivative of NC-licensed training data. |
| `ru_RU-irina-medium` | **"Unknown"** | **"Unknown"** (RHVoice-derived) | **C — LEGALLY UNCERTAIN**, functionally a REJECT for now. No confirmable rights grant exists at all; "Unknown" is not a permissive default, it means no license was ever asserted. Would need the original rights-holder (RHVoice Lab, see below) to explicitly clarify terms before this could move to A or a confirmed B. |

## Alternative engine considered: RHVoice

Requirement checklist: Windows ✔, fully local/offline ✔, Russian ✔
(purpose-built for it), commercially usable engine ✔ (with a caveat
below), closed-source compatible ✔, no cloud API ✔, native (not
Python/PyTorch) ✔ — but **not neural** (classical formant/unit-selection
synthesis, predates the neural-TTS generation Piper belongs to), which
directly undercuts WK-74's original motivation (a quality upgrade over
the existing browser `SpeechSynthesis`).

- **Engine license: LGPL-2.1+** for the core library — genuinely more
  permissive than GPL for this use case. LGPL explicitly permits dynamic
  linking into a closed-source application without requiring the
  application itself to be open-sourced, as long as the LGPL component
  stays separately replaceable and its own source stays available —
  meaningfully better than either GPL path above.
  **Caveat with a specific, actionable fix:** RHVoice optionally links
  "MAGE" for better responsiveness, and the combination with MAGE is
  GPL-3.0+, not LGPL. **Building without MAGE is required** to keep the
  favorable LGPL terms — a concrete build flag to enforce, not a
  judgment call.
- **Voice license: blocked by default, but not a dead end.** RHVoice
  Lab's own voices (the Russian ones among them) are distributed under
  **CC BY-NC-ND 4.0** (NonCommercial **and** NoDerivatives) — a harder
  block than Piper's `ruslan` case (NoDerivatives forbids even
  adapting/fine-tuning the voice), confirmed verbatim in the project's own
  [`doc/en/License.md`](https://github.com/RHVoice/RHVoice/blob/master/doc/en/License.md):
  "All voices from RHVoice Lab's site are distributed under the [CC
  BY-NC-ND 4.0] License." **B — REJECT** for RHVoice's own voices in a
  commercial product, as-is. Unlike Piper's voices, there's a documented
  door here: the same page states "You can send a request for integration
  of voice into any product to the laboratory's e-mail address. If the
  approval is given by the speaker and our team you will get the
  appropriate permission" — i.e., this could become **A** with a direct
  licensing request to `rhvoice@tiflo.org`, not something to rule out
  permanently, just not usable without that step. No alternative
  permissively-licensed RHVoice-compatible Russian voice was found in this
  pass.

Net: RHVoice's *engine* license is actually better than Piper's, but its
*voice* license is worse than Piper's clean voices, and its synthesis
quality doesn't serve the original "better than browser TTS" goal even if
a clean voice existed. Not recommended.

## Alternative considered and rejected outright: Windows' own on-device neural voices

Windows 11 does ship genuinely on-device neural voices (Narrator's
"Natural voices," downloaded once via Settings, synthesized locally, not
per-utterance cloud calls). This looked like it might sidestep the entire
third-party-license question by using an OS capability every Windows app
is licensed to call. It doesn't hold up:

Microsoft has not published a supported API for third-party apps to use
these specific voices. The only working access path found
([`NaturalVoiceSAPIAdapter`](https://github.com/gexgd0419/NaturalVoiceSAPIAdapter))
works by "using encryption keys extracted from system files," is
explicitly unofficial, and can "stop working at any time after a system
update." Shipping a commercial product that depends on extracting
encryption keys from system files to unlock voices Microsoft hasn't
authorized third-party use of is both a legal risk (Windows EULA/ToS,
DRM-circumvention-adjacent territory) and an operational one (breaks on
any Windows Update with no advance notice). **Not viable — do not pursue.**

The *older*, officially-documented SAPI5 "Desktop" voices (non-neural,
e.g. whatever legacy Russian voice a user has installed) remain
zero-risk and are what Companion's existing WK-66 browser-`SpeechSynthesis`
feature already gets for free via WebView2 — but they're the status quo
being evaluated against, not an upgrade.

## Decision matrix

| Engine/runtime | Integration | Voice | Commercial use | Closed-source compatibility | Maintenance | Runtime cost | Verdict |
|---|---|---|---|---|---|---|---|
| `rhasspy/piper` 2023.11.14-2 (MIT) + `espeak-ng.dll` (GPL-3.0) | Subprocess (sidecar), plain text/WAV over stdio | `ru_RU-denis-medium` (MIT/CC0) | Yes, with GPL source-offer duty for the bundled `espeak-ng.dll` only | Yes — Companion itself stays closed-source | **Stale** — unmaintained since 2023-11-14 | ~220ms load, ~15–110ms/msg after, ~147MB peak RAM (measured) | **A** — usable now, maintenance risk |
| Self-built `OHF-Voice/piper1-gpl` `libpiper` CLI (GPL-3.0) | Subprocess (sidecar), same IPC shape | `ru_RU-denis-medium` or `dmitri` (MIT/CC0) | Yes, same GPL source-offer duty | Yes | **Active** upstream (`v1.7.0`, 2026-08-15) | Same order of magnitude as above (same ONNX voice + onnxruntime) — not yet re-measured on this exact build | **A — recommended** (see below) |
| `piper-rs` (Rust crate) | Linked into Companion's own binary | any | **No** | **No** — GPL-3.0 covers the whole combination per FSF FAQ | Crate itself last published, but irrelevant — architecturally rejected | N/A | **B — REJECT** |
| Maintained Piper Python sidecar (`piper-tts` wheel, GPL-3.0) | Subprocess, same IPC shape | `ru_RU-denis-medium` or `dmitri` | Yes, same GPL source-offer duty | Yes | Active | Same synthesis cost + Python interpreter startup/footprint on top | **A**, but strictly worse than the self-built native path (interpreter to bundle) |
| RHVoice (LGPL-2.1+ engine, built without MAGE) | Dynamic link or subprocess | RHVoice Lab voices (CC BY-NC-ND 4.0) | **No** — voice blocks it | Engine alone: yes | Actively packaged (Linux distros) | Not measured (classical synthesis, not neural — lighter than ONNX-neural, likely) | Engine **A**, voice **B** → net **not usable** without a different voice source |
| Windows on-device "Natural" neural voices via unofficial SAPI adapter | Undocumented, uses extracted encryption keys | Whatever's installed | Legally risky regardless of "commercial" framing | Fragile, breaks on Windows Update | N/A — unofficial | Not measured | **Rejected outright** — not evaluated further |

## Recommendation

**Implement**: a small first-party native CLI wrapper built from
`OHF-Voice/piper1-gpl`'s `libpiper` (C API documented in
`libpiper/README.md`), run as a persistent subprocess/sidecar from
Companion exactly the way the prototype validated (spawn once when TTS is
enabled, feed chat lines over stdin, read WAV/raw audio back), shipping
`ru_RU-denis-medium` (or `dmitri`) as the bundled voice.

Why this exact path over the alternatives above:
- It's the only combination that is simultaneously **A** on licensing
  (engine, IPC shape, *and* voice all individually clean), **actively
  maintained** upstream, and **already performance-validated** (the prior
  prototype's numbers apply directly — same ONNX voice, same onnxruntime,
  same synthesis cost profile; only the wrapper binary itself is new).
- It's strictly better than path 1 (same license position, not stale) and
  path 4 (same license position, no interpreter to bundle).
- `piper-rs` is off the table outright (B) regardless of voice choice.
- RHVoice's better engine license doesn't matter because its own voices
  are blocked, and it wouldn't deliver the quality upgrade WK-74 wanted
  anyway.
- The Windows-native path is not a real option at all — it requires an
  unofficial hack, not a licensing tradeoff.

**Before opening the implementation ticket**, two concrete asks:
1. Confirm your own read of the Q2 (subprocess) position above — this is
   FSF's stated interpretation plus well-established industry practice,
   not case law, and it's the legal foundation the entire recommendation
   rests on. If your risk tolerance wants outside legal sign-off on that
   specific point before shipping, get it now, not after the ticket is
   written.
2. Building `libpiper` requires standing up a CMake + C/C++ toolchain
   step in Companion's Windows CI (`windows-release.yml` currently has
   none) that fetches/builds `espeak-ng` and `onnxruntime` per
   `libpiper/README.md` — worth a small time-boxed spike to confirm it
   builds cleanly in GitHub Actions' `windows-latest` runner before
   committing to the full feature ticket, since that's the one part of
   this recommendation not yet hands-on-verified (only the *architecture*
   was verified, not the CI build itself).

## Sources

- [GNU GPL FAQ — gnu.org/licenses/gpl-faq.html](https://www.gnu.org/licenses/gpl-faq.html)
  ("aggregate" vs. combined work; static/dynamic linking)
- [espeak-ng/espeak-ng — COPYING](https://github.com/espeak-ng/espeak-ng/blob/master/COPYING) (GPL-3.0, verified via `gh api .../license` and raw file content)
- [OHF-Voice/piper1-gpl](https://github.com/OHF-Voice/piper1-gpl) — repo license (GPL-3.0), `libpiper/README.md`, `libpiper/CMakeLists.txt`, root `CMakeLists.txt` (espeak-ng static link), `licenses/LICENSE.g2pW-Apache-2.0`
- [rhasspy/piper — license](https://github.com/rhasspy/piper) (MIT, verified via `gh api .../license`), release `2023.11.14-2` Windows asset contents
- [piper-voices MODEL_CARDs — ru/ru_RU](https://huggingface.co/rhasspy/piper-voices/tree/main/ru/ru_RU) (`denis`, `dmitri`, `ruslan`, `irina`, checked individually)
- [RHVoice/RHVoice — doc/en/License.md](https://github.com/RHVoice/RHVoice/blob/master/doc/en/License.md) (LGPL-2.1+ core, GPL-3.0+ with MAGE, RHVoice Lab voices CC BY-NC-ND 4.0 with a stated commercial-request path)
- [gexgd0419/NaturalVoiceSAPIAdapter](https://github.com/gexgd0419/NaturalVoiceSAPIAdapter) (unofficial Windows natural-voice access via extracted keys)
