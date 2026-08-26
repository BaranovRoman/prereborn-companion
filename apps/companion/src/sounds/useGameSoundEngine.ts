import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";
import { listen } from "@tauri-apps/api/event";
import { BoundedGameSoundQueue, base64ToObjectUrl, type GameSoundPlayback } from "./game-sound-model";
import * as api from "../services/dotaCompanionApi";
import type {
  GameSoundCatalog, GameSoundEventKind, GameSoundPlayNotification, GameSoundSettings,
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
export function useGameSoundEngine() {
  const [catalog, setCatalog] = useState<GameSoundCatalog | null>(null);
  const [settings, setSettings] = useState<GameSoundSettings | null>(null);
  const [error, setError] = useState<string | null>(null);

  const queue = useRef(new BoundedGameSoundQueue());
  const playing = useRef(false);
  const currentAudio = useRef<HTMLAudioElement | null>(null);
  const previewAudio = useRef<HTMLAudioElement | null>(null);
  // Rust already only emits "game-sound-play" while the master toggle is on
  // (see game_sounds/mod.rs's handle_gsi) - this ref is belt-and-suspenders
  // defense-in-depth against a stale `settings` React state briefly lagging
  // behind an in-flight setMaster(false) call, not the primary gate.
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

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

  const playNext = useCallback(() => {
    if (playing.current) return;
    const next = queue.current.takeNext();
    if (!next) return;
    playing.current = true;
    playPayload(next, () => {
      playing.current = false;
      playNext();
    }, currentAudio);
  }, []);

  useEffect(() => {
    const unlistenPromise = listen<GameSoundPlayNotification>("game-sound-play", (event) => {
      if (!settingsRef.current?.enabled) return;
      const item: GameSoundPlayback = event.payload;
      if (playing.current) {
        // Bounded burst policy - a drop here is silent by design (задача:
        // "новое событие либо игнорируется, либо встаёт в bounded
        // очередь"), not surfaced as an error.
        queue.current.enqueue(item);
        return;
      }
      playing.current = true;
      playPayload(item, () => {
        playing.current = false;
        playNext();
      }, currentAudio);
    });
    return () => { void unlistenPromise.then((unlisten) => unlisten()); };
  }, [playNext]);

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
    audio.volume = volume / 100;
    previewAudio.current = audio;
    const cleanup = () => {
      URL.revokeObjectURL(url);
      if (previewAudio.current === audio) previewAudio.current = null;
    };
    audio.onended = cleanup;
    audio.onerror = cleanup;
    await audio.play().catch(cleanup);
  }, [stopPreview]);

  return { catalog, settings, error, setMaster, setBinding, removeBinding, chooseAndBindFile, preview, stopPreview };
}

// Module-level helper (not a hook) so playNext/the listener above can share
// the exact same playback path - decode, play, and always call `done()`
// exactly once, whether playback finished normally or errored (задача:
// "playback error не ломает listener" - errors clean up and hand control
// back to the queue instead of leaving `playing` stuck true forever).
function playPayload(
  item: GameSoundPlayback,
  done: () => void,
  currentAudio: MutableRefObject<HTMLAudioElement | null>,
) {
  const url = base64ToObjectUrl(item.base64, item.mime);
  const audio = new Audio(url);
  audio.volume = item.volume / 100;
  currentAudio.current = audio;
  const cleanup = () => {
    URL.revokeObjectURL(url);
    if (currentAudio.current === audio) currentAudio.current = null;
    done();
  };
  audio.onended = cleanup;
  audio.onerror = cleanup;
  audio.play().catch(cleanup);
}
