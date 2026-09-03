import type { TwitchChatSession } from "../../chat/useTwitchChatSession";
import type { useGameSoundEngine } from "../../sounds/useGameSoundEngine";
import { Slider } from "../ui";

interface Props {
  overallVolume: number;
  onOverallVolumeChange: (value: number) => void;
  chatSession: TwitchChatSession;
  gameSoundEngine: ReturnType<typeof useGameSoundEngine>;
}

// WK-135 - Audio Settings consolidation. Three volume controls in one place
// instead of scattered across ChatTtsSettings ("Громкость речи") and
// SoundsPage ("Громкость"), which are removed once this exists (see those
// files' own WK-135 comments). "Общий" is a NEW multiplier (see
// useOverallVolume.ts) - effective_tts = Общий × TTS, effective_custom =
// Общий × Кастомные звуки, applied at playback time only in
// useTwitchChatSession.ts/useGameSoundEngine.ts. The Custom Sounds and TTS
// sliders themselves still write through the exact same setters
// (setMaster/updateSetting) they always did - no new persisted schema for
// either, only "Общий" is new state.
export function AudioSettings({ overallVolume, onOverallVolumeChange, chatSession, gameSoundEngine }: Props) {
  const { settings: soundSettings, setMaster } = gameSoundEngine;
  const { settings: chatSettings, updateSetting } = chatSession;

  return (
    <div className="chat-settings chat-settings--in-panel audio-settings">
      <h3>Аудио</h3>
      <label className="tts-volume">
        <span className="tts-volume__row"><span>Общий</span><span className="tts-volume__value">{overallVolume}%</span></span>
        <Slider
          min={0}
          max={100}
          value={overallVolume}
          onChange={(event) => onOverallVolumeChange(Number(event.target.value))}
          aria-label="Общий"
        />
      </label>
      {soundSettings && (
        <label className={`tts-volume ${!soundSettings.enabled ? "is-disabled" : ""}`}>
          <span className="tts-volume__row"><span>Кастомные звуки</span><span className="tts-volume__value">{soundSettings.masterVolume}%</span></span>
          <Slider
            min={0}
            max={100}
            disabled={!soundSettings.enabled}
            value={soundSettings.masterVolume}
            onChange={(event) => void setMaster(soundSettings.enabled, Number(event.target.value))}
            aria-label="Кастомные звуки"
          />
        </label>
      )}
      <label className={`tts-volume ${!chatSettings.ttsEnabled ? "is-disabled" : ""}`}>
        <span className="tts-volume__row"><span>TTS</span><span className="tts-volume__value">{chatSettings.speechVolume}%</span></span>
        <Slider
          min={0}
          max={100}
          disabled={!chatSettings.ttsEnabled}
          value={chatSettings.speechVolume}
          onChange={(event) => updateSetting("speechVolume", Number(event.target.value))}
          aria-label="TTS"
        />
      </label>
      <p>Итоговая громкость каждого источника = Общий × его собственный ползунок.</p>
    </div>
  );
}
