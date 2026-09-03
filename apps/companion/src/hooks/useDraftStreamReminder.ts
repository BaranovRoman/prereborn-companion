import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { base64ToObjectUrl } from "../sounds/game-sound-model";
import { synthesizeSileroTts, type SileroVoice } from "../services/dotaCompanionApi";

// Mirrors the Rust side's draft_reminder.rs constant exactly (hardcoded here
// rather than imported, the same convention useTwitchChatSession.ts already
// uses for SKIP_TTS_EVENT - there's no shared Rust<->TS constants module in
// this codebase).
const DRAFT_STREAM_NOT_STARTED_EVENT = "reminders://draft-stream-not-started";
const REMINDER_TEXT = "Стрим не запущен";
const STORAGE_KEY = "companion-system-voice-reminders-v1";

function loadEnabled(): boolean {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw == null ? true : raw === "true";
  } catch {
    return true;
  }
}

// WK-136 - "Стрим не запущен" local voice reminder. Deliberately independent
// of the Twitch chat TTS queue/ChatSettings.ttsEnabled (product preference:
// this is an operational Companion warning, not viewer TTS) - it calls
// synthesizeSileroTts directly and plays the result itself, bypassing
// BoundedTtsQueue entirely, with its own small enable toggle instead. Reuses
// the voice the user already configured/previewed for chat TTS
// (chatSession.settings.sileroVoice, passed in as `voice`) rather than
// inventing a second "reminder voice" setting.
export function useDraftStreamReminder(voice: SileroVoice) {
  const [enabled, setEnabledState] = useState(loadEnabled);
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const voiceRef = useRef(voice);
  voiceRef.current = voice;

  const setEnabled = useCallback((next: boolean) => {
    setEnabledState(next);
    try {
      localStorage.setItem(STORAGE_KEY, String(next));
    } catch {
      // Best-effort persistence - a blocked/full localStorage must not
      // crash the toggle, it just won't survive a restart.
    }
  }, []);

  useEffect(() => {
    const unlistenPromise = listen(DRAFT_STREAM_NOT_STARTED_EVENT, () => {
      if (!enabledRef.current) return;
      synthesizeSileroTts(REMINDER_TEXT, voiceRef.current)
        .then((base64) => {
          const url = base64ToObjectUrl(base64, "audio/wav");
          const audio = new Audio(url);
          const cleanup = () => URL.revokeObjectURL(url);
          audio.onended = cleanup;
          audio.onerror = cleanup;
          return audio.play().catch(cleanup);
        })
        .catch(() => {
          // A local reminder failing to synthesize/play (Silero busy/
          // crashed) is never surfaced as an app error - the streamer still
          // has every other on-screen indication of stream state.
        });
    });
    return () => { void unlistenPromise.then((unlisten) => unlisten()); };
  }, []);

  return { enabled, setEnabled };
}
