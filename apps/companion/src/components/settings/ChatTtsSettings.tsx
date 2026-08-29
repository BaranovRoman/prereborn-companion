import type { ChatSettings } from "../../chat/chat-model";
import type { TwitchChatSession } from "../../chat/useTwitchChatSession";
import type { SileroVoice } from "../../services/dotaCompanionApi";
import { Checkbox, Radio, Select, Slider } from "../ui";

const SILERO_VOICES: { value: SileroVoice; label: string }[] = [
  { value: "xenia", label: "Xenia" },
  { value: "baya", label: "Baya" },
  { value: "kseniya", label: "Kseniya" },
  { value: "aidar", label: "Aidar" },
  { value: "eugene", label: "Eugene" },
];

// WK-121 §4 - "Чат и TTS" Settings category. Owns every PERMANENT chat/TTS
// preference (notification sound, TTS enable/engine/voice/volume,
// speak-author, max length, per-username pronunciation) that used to live
// inline in the Chat screen's sidebar. Takes the SAME TwitchChatSession
// instance AppShell already owns (one useTwitchChatSession() call for the
// whole app - see AppShell.tsx) so this is a second UI surface reading the
// same state, never a second copy of it. Chat itself keeps only runtime
// concerns: messages, connection state, and the TTS skip/stop actions (see
// TwitchChatPage.tsx after this move).
export function ChatTtsSettings({ session }: { session: TwitchChatSession }) {
  const { settings, sileroStatus, sileroBusy, previewBusy, previewError, previewSileroVoice, updateSetting } = session;
  const update = <K extends keyof ChatSettings>(key: K, value: ChatSettings[K]) => updateSetting(key, value);

  return (
    <div className="chat-settings chat-settings--in-panel">
      <Checkbox
        label="Звук нового сообщения"
        checked={settings.soundEnabled}
        onChange={(event) => update("soundEnabled", event.target.checked)}
      />
      <Checkbox
        label="Озвучивать сообщения (TTS)"
        checked={settings.ttsEnabled}
        onChange={(event) => update("ttsEnabled", event.target.checked)}
      />
      <div className={`tts-engine-choice ${!settings.ttsEnabled ? "is-disabled" : ""}`}>
        <Radio
          name="ttsEngine"
          disabled={!settings.ttsEnabled}
          checked={settings.ttsEngine === "silero"}
          onChange={() => update("ttsEngine", "silero")}
          label="Silero (локальный, офлайн, рекомендуется)"
        />
        <Radio
          name="ttsEngine"
          disabled={!settings.ttsEnabled}
          checked={settings.ttsEngine === "system"}
          onChange={() => update("ttsEngine", "system")}
          label="Системный голос"
        />
      </div>
      <label className={`tts-volume ${!settings.ttsEnabled ? "is-disabled" : ""}`}>
        <span className="tts-volume__row"><span>Громкость речи</span><span className="tts-volume__value">{settings.speechVolume}%</span></span>
        <Slider
          min={0}
          max={100}
          step={1}
          disabled={!settings.ttsEnabled}
          value={settings.speechVolume}
          onChange={(event) => update("speechVolume", Number(event.target.value))}
          aria-label="Громкость речи"
        />
      </label>
      {settings.ttsEnabled && settings.ttsEngine === "silero" && (
        <>
          <label>Голос
            <Select value={settings.sileroVoice} onChange={(event) => update("sileroVoice", event.target.value as SileroVoice)}>
              {SILERO_VOICES.map(({ value, label }) => <option key={value} value={value}>{label}</option>)}
            </Select>
          </label>
          <button
            type="button"
            className="ui-button"
            onClick={() => previewSileroVoice(settings.sileroVoice)}
            disabled={previewBusy || !sileroStatus?.resourcesReady}
          >
            {previewBusy ? "Синтез…" : "Прослушать"}
          </button>
          {previewError && <p className="app__error">Не удалось синтезировать пример: {previewError}</p>}
          <p className="tts-piper-status">
            {sileroBusy || sileroStatus?.state === "starting" ? "Silero: загрузка/запуск…"
              : sileroStatus?.state === "ready" ? "Silero: готов"
              : sileroStatus?.state === "crashed" || sileroStatus?.state === "unavailable"
                ? `Silero недоступен, читаем системным голосом: ${sileroStatus.lastError ?? "неизвестная ошибка"}`
                : "Silero: ожидание первого сообщения"}
          </p>
          <p className="tts-license-note">
            Silero <code>v5_5_ru</code> (<a href="https://github.com/snakers4/silero-models/blob/master/LICENSE" target="_blank" rel="noreferrer">CC BY-NC-SA 4.0, некоммерческая лицензия</a>) — используется только пока Companion остаётся некоммерческим продуктом. Запускается отдельным процессом (Python + PyTorch), не встроен в приложение. При недоступности автоматически переключаемся на системный голос.
          </p>
        </>
      )}
      <Checkbox
        label="Произносить имя автора"
        className={!settings.ttsEnabled ? "is-disabled" : ""}
        disabled={!settings.ttsEnabled}
        checked={settings.speakAuthor}
        onChange={(event) => update("speakAuthor", event.target.checked)}
      />
      <label className={!settings.ttsEnabled ? "is-disabled" : ""}>Максимальная длина
        <Select disabled={!settings.ttsEnabled} value={settings.maxLength} onChange={(event) => update("maxLength", Number(event.target.value))}>
          <option value={80}>80 символов</option><option value={180}>180 символов</option><option value={300}>300 символов</option>
        </Select>
      </label>
      <label className={!settings.ttsEnabled || !settings.speakAuthor ? "is-disabled" : ""}>Произношение никнеймов (по одному на строку: ник=как произносить)
        <textarea
          disabled={!settings.ttsEnabled || !settings.speakAuthor}
          value={settings.usernamePronunciations}
          onChange={(event) => update("usernamePronunciations", event.target.value)}
          placeholder={"romaromych=Ромаромыч"}
          rows={3}
        />
      </label>
      <p>TTS выключен по умолчанию. Ссылки, системные события и явный спам не читаются.</p>
    </div>
  );
}
