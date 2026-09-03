import { useCallback, useState } from "react";

const STORAGE_KEY = "companion-overall-volume-v1";
const DEFAULT_OVERALL_VOLUME = 100;

function clamp(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_OVERALL_VOLUME;
  return Math.min(100, Math.max(0, Math.round(value)));
}

function load(): number {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw == null) return DEFAULT_OVERALL_VOLUME;
    return clamp(Number(raw));
  } catch {
    return DEFAULT_OVERALL_VOLUME;
  }
}

// WK-135 - Audio Settings consolidation. "Overall" is a NEW multiplier that
// didn't exist before - effective_tts = overall × TTS, effective_custom =
// overall × Custom Sounds (see useTwitchChatSession.ts/useGameSoundEngine.ts
// for where the multiplication actually happens, at playback time only).
// Defaults to 100 so an existing user's TTS/Custom-Sounds volumes are
// unchanged until they touch this new slider - a safe, no-op-by-default
// migration. Stored locally (mirrors ChatSettings.speechVolume's own
// localStorage pattern) rather than in the Rust-persisted GameSoundSettings,
// since Custom Sounds' own master_volume stays untouched by this feature.
export function useOverallVolume() {
  const [overallVolume, setOverallVolumeState] = useState(load);

  const setOverallVolume = useCallback((value: number) => {
    const next = clamp(value);
    setOverallVolumeState(next);
    try {
      localStorage.setItem(STORAGE_KEY, String(next));
    } catch {
      // Best-effort persistence - a blocked/full localStorage must not
      // crash the volume slider, it just won't survive a restart.
    }
  }, []);

  return { overallVolume, setOverallVolume };
}
