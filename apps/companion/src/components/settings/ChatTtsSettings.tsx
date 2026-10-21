import type { ChatSettings } from "../../chat/chat-model";
import type { TwitchChatSession } from "../../chat/useTwitchChatSession";
import type { SileroVoice } from "../../core/contracts";
import { Badge, Button, ChoiceGroup, Field, Notice, Radio, Select, SettingsGroup, SettingsRow, Switch, Textarea } from "../ui";

const SILERO_VOICES: { value: SileroVoice; label: string }[] = [
  { value: "xenia", label: "Xenia" },
  { value: "baya", label: "Baya" },
  { value: "kseniya", label: "Kseniya" },
  { value: "aidar", label: "Aidar" },
  { value: "eugene", label: "Eugene" },
];

// WK-121 §4 - "Чат и TTS" Settings category. Owns every PERMANENT chat/TTS
// preference (TTS enable/engine/voice, speak-author, max length,
// per-username pronunciation) that used to live inline in the Chat screen's
// sidebar. Takes the SAME TwitchChatSession instance AppShell already owns
// (one useTwitchChatSession() call for the whole app) so this is a second UI
// surface reading the same state, never a second copy of it. Chat itself
// keeps only runtime concerns: messages, connection state, and the TTS
// skip/stop actions. The new-message sound lives with the notification
// switches (see SpeechNotifications).
export function ChatTtsSettings({ session }: { session: TwitchChatSession }) {
  const { settings, sileroStatus, sileroBusy, previewBusy, previewError, previewSileroVoice, updateSetting } = session;
  const update = <K extends keyof ChatSettings>(key: K, value: ChatSettings[K]) => updateSetting(key, value);
  const off = !settings.ttsEnabled;
  const silero = settings.ttsEngine === "silero";
  const sileroState = sileroBusy || sileroStatus?.state === "starting" ? { tone: "warning" as const, text: "Загрузка…" }
    : sileroStatus?.state === "ready" ? { tone: "success" as const, text: "Готов" }
    : sileroStatus?.state === "crashed" || sileroStatus?.state === "unavailable" ? { tone: "danger" as const, text: "Недоступен" }
    : { tone: "default" as const, text: "Запустится с первым сообщением" };

  return (
    <div className="chat-settings">
      <SettingsGroup>
        <SettingsRow label="Озвучивать сообщения (TTS)" description="Ссылки, системные события и явный спам не читаются. По умолчанию выключено.">
          <Switch aria-label="Озвучивать сообщения (TTS)" checked={settings.ttsEnabled} onChange={(event) => update("ttsEnabled", event.target.checked)} />
        </SettingsRow>
      </SettingsGroup>

      <div className={`chat-settings__voice${off ? " is-disabled" : ""}`}>
        <h3 className="ui-settings-group__title">Голос</h3>
        <ChoiceGroup legend="Движок озвучки" row>
          <Radio
            card
            name="ttsEngine"
            disabled={off}
            checked={silero}
            onChange={() => update("ttsEngine", "silero")}
            label="Silero"
            hint="Локальный, работает офлайн. Рекомендуется"
          />
          <Radio
            card
            name="ttsEngine"
            disabled={off}
            checked={settings.ttsEngine === "system"}
            onChange={() => update("ttsEngine", "system")}
            label="Системный голос"
            hint="Голос Windows, без загрузки моделей"
          />
        </ChoiceGroup>

        {!off && silero && (
          <div className="chat-settings__silero">
            <div className="chat-settings__voice-row">
              <Field label="Голос Silero" disabled={off}>
                <Select disabled={off} value={settings.sileroVoice} onChange={(event) => update("sileroVoice", event.target.value as SileroVoice)}>
                  {SILERO_VOICES.map(({ value, label }) => <option key={value} value={value}>{label}</option>)}
                </Select>
              </Field>
              <Button
                onClick={() => previewSileroVoice(settings.sileroVoice)}
                disabled={off || previewBusy || !sileroStatus?.resourcesReady}
              >
                {previewBusy ? "Синтез…" : "Прослушать"}
              </Button>
              <Badge tone={sileroState.tone} dot>Silero: {sileroState.text}</Badge>
            </div>
            {(sileroStatus?.state === "crashed" || sileroStatus?.state === "unavailable") && (
              <Notice tone="warning">Silero недоступен, сообщения читаются системным голосом: {sileroStatus.lastError ?? "неизвестная ошибка"}</Notice>
            )}
            {previewError && <Notice tone="danger">Не удалось синтезировать пример: {previewError}</Notice>}
            <p className="tts-license-note">
              Silero <code>v5_5_ru</code> (<a href="https://github.com/snakers4/silero-models/blob/master/LICENSE" target="_blank" rel="noreferrer">CC BY-NC-SA 4.0, некоммерческая лицензия</a>) — используется, пока Companion остаётся некоммерческим продуктом. Запускается отдельным процессом (Python + PyTorch); при недоступности Companion переключается на системный голос.
            </p>
          </div>
        )}
      </div>

      <SettingsGroup title="Чтение сообщений">
        <SettingsRow label="Произносить имя автора" description="Перед текстом сообщения звучит ник зрителя">
          <Switch aria-label="Произносить имя автора" disabled={off} checked={settings.speakAuthor} onChange={(event) => update("speakAuthor", event.target.checked)} />
        </SettingsRow>
        <SettingsRow label="Максимальная длина" description="Длинные сообщения обрезаются до выбранного размера">
          <Select aria-label="Максимальная длина" className="chat-settings__length" disabled={off} value={settings.maxLength} onChange={(event) => update("maxLength", Number(event.target.value))}>
            <option value={0}>Читать полностью</option><option value={80}>80 символов</option><option value={300}>300 символов</option>
          </Select>
        </SettingsRow>
        <SettingsRow stacked label="Произношение никнеймов" description="По одному на строку: ник=как произносить">
          <Textarea
            aria-label="Произношение никнеймов"
            disabled={off || !settings.speakAuthor}
            value={settings.usernamePronunciations}
            onChange={(event) => update("usernamePronunciations", event.target.value)}
            placeholder={"romaromych=Ромаромыч"}
            rows={3}
          />
        </SettingsRow>
      </SettingsGroup>
    </div>
  );
}

// Immediate on/off sounds that are not TTS itself: the chat ping and the
// plugin voice reminders. Persistence stays with each owner.
export function SpeechNotifications({ session, voiceNotifications, onVoiceNotifications }: { session: TwitchChatSession; voiceNotifications: boolean; onVoiceNotifications: (enabled: boolean) => void }) {
  return (
    <SettingsGroup>
      <SettingsRow label="Звук нового сообщения" description="Короткий сигнал, когда в чат приходит сообщение">
        <Switch aria-label="Звук нового сообщения" checked={session.settings.soundEnabled} onChange={(event) => session.updateSetting("soundEnabled", event.target.checked)} />
      </SettingsRow>
      <SettingsRow label="Голосовые уведомления плагинов" description="Напоминания расширений (например, Dota) выбранным голосом Silero. Не попадают в очередь сообщений Twitch.">
        <Switch aria-label="Разрешить голосовые уведомления" checked={voiceNotifications} onChange={(event) => onVoiceNotifications(event.target.checked)} />
      </SettingsRow>
    </SettingsGroup>
  );
}
