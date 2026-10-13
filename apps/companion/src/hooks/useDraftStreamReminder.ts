import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { gameAudioFence, stopGameAudio, type GameAudioToken } from "../sounds/game-audio-fence";
import { applySinkId } from "../audio/outputDevice";
import { base64ToObjectUrl } from "../sounds/game-sound-model";
import { synthesizeSileroTts, type SileroVoice } from "../core/api";

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
    let active = true;
    const owned = new Set<() => boolean>();
    const unlistenPromise = listen<{ playback: GameAudioToken }>(DRAFT_STREAM_NOT_STARTED_EVENT, (event) => {
      const token = event.payload?.playback;
      if (!active || !enabledRef.current) { gameAudioFence.report(token, "cancelled"); return; }
      let cancelled = false;
      let player: HTMLAudioElement | null = null;
      let release: (() => void) | null = null;
      const cancel = () => {
        cancelled = true;
        const stopped = !player || stopGameAudio(player);
        release?.();
        gameAudioFence.report(token, stopped ? "cancelled" : "unknown");
        return stopped;
      };
      if (!gameAudioFence.track(token, cancel)) { gameAudioFence.report(token, "unknown"); return; }
      owned.add(cancel);
      synthesizeSileroTts(REMINDER_TEXT, voiceRef.current)
        .then((base64) => {
          if (!active || cancelled || !gameAudioFence.accepts(token)) return;
          const url = base64ToObjectUrl(base64, "audio/wav");
          const audio = new Audio(url);
          player = audio;
          let finished = false;
          const cleanup = () => { owned.delete(cancel); if (!finished) { finished = true; URL.revokeObjectURL(url); } };
          release = cleanup;
          audio.onended = () => { cleanup(); gameAudioFence.report(token, "completed"); };
          audio.onerror = () => { const stopped = stopGameAudio(audio); cleanup(); gameAudioFence.report(token, stopped ? "cancelled" : "unknown"); };
          void applySinkId(audio);
          return audio.play().then(() => {
            if (!cancelled) gameAudioFence.report(token, "playing");
          }).catch(() => { const stopped = stopGameAudio(audio); cleanup(); if (!cancelled) gameAudioFence.report(token, stopped ? "cancelled" : "unknown"); });
        })
        .catch(() => {
          owned.delete(cancel);
          if (!cancelled) gameAudioFence.report(token, "cancelled"); // synthesis failed before a player existed
          // A local reminder failing to synthesize/play (Silero busy/
          // crashed) is never surfaced as an app error - the streamer still
          // has every other on-screen indication of stream state.
        });
    });
    return () => {
      active = false;
      for (const cancel of owned) cancel();
      owned.clear();
      void unlistenPromise.then((unlisten) => unlisten());
    };
  }, []);

  return { enabled, setEnabled };
}
