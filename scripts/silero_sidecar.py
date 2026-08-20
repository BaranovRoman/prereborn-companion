# WK-81 - persistent Silero TTS sidecar, run as a subprocess by
# apps/companion/src-tauri/src/silero.rs. Packaged into
# silero-runtime-win-x64.zip alongside a self-contained Python +
# PyTorch CPU runtime (see scripts/companion-build-silero-runtime.ps1) -
# never bundled in the Companion installer itself, never assumes a system
# Python is present.
#
# Protocol: one JSON object per line on stdin -> one JSON object per line
# on stdout, strictly correlated by "id". No directory polling, no
# "newest file" guessing - see docs/research/wk-81-silero-tts-feasibility.md
# and Piper's WK-79 fix (tts.rs) for why that class of heuristic is unsafe.
#
#   stdin:  {"id": "req-1", "text": "...", "speaker": "xenia"}
#   stdout: {"id": "req-1", "ok": true, "wav": "<absolute path>"}
#        or {"id": "req-1", "ok": false, "error": "..."}
#
# On startup, once the model is fully loaded, prints exactly one readiness
# line: {"ready": true}. If model load itself fails, prints
# {"ok": false, "fatal": true, "error": "..."} and exits non-zero instead
# of pretending to be ready.
import json
import sys
import wave

import numpy as np
import torch

SAMPLE_RATE = 48000


def main():
    if len(sys.argv) != 3:
        print(json.dumps({"ok": False, "fatal": True, "error": "usage: silero_sidecar.py <model.pt> <output_dir>"}), flush=True)
        sys.exit(1)
    model_path, output_dir = sys.argv[1], sys.argv[2]

    # Bounded, not "use every core" - this is a chat-TTS sidecar synthesizing
    # one short utterance at a time (calls are serialized by the Rust side's
    # Mutex), not a batch workload; leaves headroom for the game/stream the
    # user is actually running.
    torch.set_num_threads(4)

    try:
        model = torch.package.PackageImporter(model_path).load_pickle("tts_models", "model")
        model.to(torch.device("cpu"))
    except Exception as exc:
        print(json.dumps({"ok": False, "fatal": True, "error": f"model load failed: {exc}"}), flush=True)
        sys.exit(1)

    print(json.dumps({"ready": True}), flush=True)

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
            request_id = request["id"]
            text = request["text"]
            speaker = request["speaker"]
        except Exception as exc:
            # No request id could be parsed - nothing to correlate a
            # response to, so this is reported without one rather than
            # guessed at. `raw` (repr, not the bare string) makes an empty
            # line, a BOM/encoding artifact, and a genuinely malformed
            # payload distinguishable from each other in the caller's logs,
            # instead of all three collapsing into the same generic
            # "Expecting value: char 0"-shaped message.
            print(json.dumps({"ok": False, "error": f"bad request: {exc}", "raw": repr(line)}), flush=True)
            continue

        try:
            audio = model.apply_tts(text=text, speaker=speaker, sample_rate=SAMPLE_RATE)
            pcm16 = (audio.numpy() * 32767.0).astype(np.int16)
            wav_path = f"{output_dir}\\{request_id}.wav"
            with wave.open(wav_path, "wb") as wav_file:
                wav_file.setnchannels(1)
                wav_file.setsampwidth(2)
                wav_file.setframerate(SAMPLE_RATE)
                wav_file.writeframes(pcm16.tobytes())
            print(json.dumps({"id": request_id, "ok": True, "wav": wav_path}), flush=True)
        except Exception as exc:
            print(json.dumps({"id": request_id, "ok": False, "error": str(exc)}), flush=True)


if __name__ == "__main__":
    main()
