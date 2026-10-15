import { useCallback, useEffect, useRef, useState } from "react";
import { applySinkId } from "../audio/outputDevice";
import { base64ToObjectUrl, type GameSoundPlayback } from "./game-sound-model";
import * as api from "../services/dotaCompanionApi";
import { useManagedPluginAudio } from "../core/audio/useManagedPluginAudio";
import type {
  GameSoundCatalog, GameSoundEventKind, GameSoundSettings,
} from "../services/dotaCompanionApi";

// WK-106 - Custom Game Sounds. Rust (game_sounds/mod.rs's handle_gsi) is the
// single source of truth for "should this play, and at what volume" - it
// only ever emits "game-sound-play" when the master toggle is on AND a
// binding exists for the detected event, already resolved to bytes+volume.
// This hook's only job is playback: one game sound at a time, plus the
// small bounded queue documented in game-sound-model.ts, mirroring the
// HTMLAudioElement idiom chat/useTwitchChatSession.ts already uses for
// Silero TTS (new Audio(objectUrl), never Web Audio/base64-blob machinery
// beyond that) - a new player because TTS's queue/generation/cancellation
// machinery is coupled to streamed synthesis, not static files (see the
// WK-106 research report, section C).
// WK-135 - `overallVolume` is the new Audio Settings "Общий" multiplier
// (see useOverallVolume.ts). Defaults to 100 (no attenuation) so existing
// callers/tests that don't pass it keep today's exact behavior.
export function useGameSoundEngine(overallVolume: number = 100) {
  const [catalog, setCatalog] = useState<GameSoundCatalog | null>(null);
  const [settings, setSettings] = useState<GameSoundSettings | null>(null);
  const [error, setError] = useState<string | null>(null);

  const previewAudio = useRef<HTMLAudioElement | null>(null);
  const overallRef = useRef(overallVolume); overallRef.current = overallVolume;
  useManagedPluginAudio({ enabled: !!settings?.enabled, eventName: "game-sound-play", fenceEvent: "game-audio-fence", fenceAckCommand: "game_audio_fence_ack", onTiming: logTiming }, overallVolume);

  useEffect(() => {
    let active = true;
    Promise.all([api.getGameSoundCatalog(), api.getGameSoundSettings()])
      .then(([nextCatalog, nextSettings]) => {
        if (!active) return;
        setCatalog(nextCatalog);
        setSettings(nextSettings);
      })
      .catch((cause) => { if (active) setError(String(cause)); });
    return () => { active = false; };
  }, []);

  const setMaster = useCallback(async (enabled: boolean, volume: number) => {
    try {
      setSettings(await api.updateGameSoundMaster(enabled, volume));
      setError(null);
    } catch (cause) {
      setError(String(cause));
      throw cause;
    }
  }, []);

  const setBinding = useCallback(async (eventId: string, kind: GameSoundEventKind, assetId: string) => {
    try {
      setSettings(await api.setGameSoundBinding(eventId, kind, assetId));
      setError(null);
    } catch (cause) {
      setError(String(cause));
      throw cause;
    }
  }, []);

  const removeBinding = useCallback(async (eventId: string) => {
    try {
      setSettings(await api.removeGameSoundBinding(eventId));
      setError(null);
    } catch (cause) {
      setError(String(cause));
      throw cause;
    }
  }, []);

  const chooseAndBindFile = useCallback(async (eventId: string, kind: GameSoundEventKind) => {
    try {
      setSettings(await api.importAndBindGameSound(eventId, kind));
      setError(null);
    } catch (cause) {
      setError(String(cause));
      throw cause;
    }
  }, []);

  const stopPreview = useCallback(() => {
    if (previewAudio.current) {
      previewAudio.current.pause();
      previewAudio.current = null;
    }
  }, []);

  const preview = useCallback(async (assetId: string, volume: number) => {
    stopPreview();
    const { base64, mime } = await api.previewGameSound(assetId);
    const url = base64ToObjectUrl(base64, mime);
    const audio = new Audio(url);
    audio.volume = (volume / 100) * (overallRef.current / 100);
    previewAudio.current = audio;
    const cleanup = () => {
      URL.revokeObjectURL(url);
      if (previewAudio.current === audio) previewAudio.current = null;
    };
    audio.onended = cleanup;
    audio.onerror = cleanup;
    void applySinkId(audio);
    await audio.play().catch(cleanup);
  }, [stopPreview]);

  return { catalog, settings, error, setMaster, setBinding, removeBinding, chooseAndBindFile, preview, stopPreview };
}

// Module-level helper (not a hook) so playNext/the listener above can share
// the exact same playback path - decode, play, and always call `done()`
// exactly once, whether playback finished normally or errored (задача:
// "playback error не ломает listener" - errors clean up and hand control
// back to the queue instead of leaving `playing` stuck true forever).
// WK-108 latency addendum - fire-and-forget breadcrumb into the shared
// rolling log (see game_sounds/mod.rs's log_frontend_timing/now_ms doc
// comments): correlates against Rust's own gsi-received/detected/play-
// request-emitted lines for the same event, so the full local pipeline
// (Dota GSI -> Companion detect -> frontend -> audio.play()) can be
// reconstructed from app.log after a stream. Never awaited by the playback
// path itself - a slow/failed log call must never delay or block a sound.
function logTiming(item: GameSoundPlayback, stage: string) {
  void api.logGameSoundTiming(item.correlationId, stage, Date.now() - item.emittedAtMs).catch(() => {});
}
