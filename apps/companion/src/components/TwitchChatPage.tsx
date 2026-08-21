import { useEffect, useRef, useState } from "react";
import type { ChatSettings } from "../chat/chat-model";
import type { TwitchChatSession } from "../chat/useTwitchChatSession";
import { openTwitchSettings, type SileroVoice, type TwitchChatMessage } from "../services/dotaCompanionApi";

// WK-81 - the 5 Silero v5_5_ru voices this integration supports. Labels
// are just the voice names (no Russian-quality/gender descriptions were
// human-verified - see the feature report), kept in a fixed, sensible
// order rather than alphabetical.
const SILERO_VOICES: { value: SileroVoice; label: string }[] = [
  { value: "xenia", label: "Xenia" },
  { value: "baya", label: "Baya" },
  { value: "kseniya", label: "Kseniya" },
  { value: "aidar", label: "Aidar" },
  { value: "eugene", label: "Eugene" },
];

// WK-78 - polling, dedup, the TTS queue/playback and unread counting used to
// live here and stopped the moment this page unmounted (e.g. switching to
// another tab). All of that now lives in useTwitchChatSession, owned once at
// the app root (HomePage) - this component is just a UI consumer of it.
export function TwitchChatPage({ session }: { session: TwitchChatSession }) {
  const {
    status, error, unread, settings, piperStatus, piperBusy, sileroStatus, sileroBusy, previewBusy, previewError,
    previewSileroVoice, updateSetting, stopTts, isSpeaking, setViewerAtBottom, markRead,
  } = session;
  const listRef = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);

  useEffect(() => {
    setViewerAtBottom(atBottom.current);
    return () => setViewerAtBottom(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (atBottom.current) listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [status?.messages.length]);

  const onScroll = () => {
    const element = listRef.current;
    if (!element) return;
    atBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 32;
    setViewerAtBottom(atBottom.current);
    if (atBottom.current) markRead();
  };
  const toLatest = () => {
    const element = listRef.current;
    if (element) element.scrollTo({ top: element.scrollHeight, behavior: "smooth" });
    atBottom.current = true;
    setViewerAtBottom(true);
    markRead();
  };
  const update = <K extends keyof ChatSettings>(key: K, value: ChatSettings[K]) => updateSetting(key, value);

  const [reconnectPending, setReconnectPending] = useState(false);
  const [reconnectError, setReconnectError] = useState<string | null>(null);
  const reconnectTwitch = async () => {
    setReconnectPending(true);
    try { await openTwitchSettings(); }
    catch (cause) { setReconnectError(String(cause)); }
    finally { setReconnectPending(false); }
  };

  const messages: TwitchChatMessage[] = status?.messages ?? [];
  const reauthRequired = status?.state === "reauth_required";
  const label = !status?.accountConnected
    ? "Twitch не подключён в веб-кабинете"
    : reauthRequired
      ? "Twitch нужно переподключить, чтобы получать сообщения чата"
      : status.connected ? "Чат подключён" : "Восстанавливаем подключение…";

  return <section className="chat-page">
    <div className="chat-page__header">
      <div><span className="section-heading__eyebrow">Не пропускайте зрителей</span><h2>Twitch-чат</h2><p>{status?.displayName ? `${status.displayName} · ${label}` : label}</p></div>
      <span className={`connection-pill ${status?.connected ? "is-online" : ""} ${reauthRequired ? "is-warning" : ""}`}>
        {status?.connected ? "На связи" : reauthRequired ? "Нужен повторный вход" : "Ожидание"}
      </span>
    </div>
    {(error || reconnectError) && <p className="app__error">Чат временно недоступен: {reconnectError ?? error}</p>}
    {reauthRequired && <div className="chat-reauth-banner">
      <p>Twitch нужно переподключить, чтобы получать сообщения чата. Это займёт минуту — откройте настройки и подключите Twitch заново.</p>
      <button className="button" onClick={reconnectTwitch} disabled={reconnectPending}>Открыть настройки Twitch</button>
    </div>}
    <div className="chat-layout">
      <div className="chat-stream">
        <div className="chat-messages" ref={listRef} onScroll={onScroll} aria-live="polite">
          {!messages.length && <div className="chat-empty">
            {reauthRequired
              ? "Сообщения не поступают, пока Twitch не переподключён."
              : status?.accountConnected ? "Новые сообщения появятся здесь." : "Подключите Twitch в веб-кабинете PreReborn."}
          </div>}
          {messages.map((message) => <article className="chat-message" key={message.id}>
            <div><strong style={{ color: message.color || undefined }}>{message.author}</strong><time>{new Date(message.receivedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time></div>
            <p>{message.text}</p>
          </article>)}
        </div>
        {unread > 0 && <button className="chat-latest" onClick={toLatest}>{unread} новых · К последним ↓</button>}
      </div>
      <aside className="chat-settings">
        <h3>Уведомления</h3>
        <label><input type="checkbox" checked={settings.soundEnabled} onChange={(event) => update("soundEnabled", event.target.checked)} /> Звук нового сообщения</label>
        <label><input type="checkbox" checked={settings.ttsEnabled} onChange={(event) => update("ttsEnabled", event.target.checked)} /> Озвучивать сообщения</label>
        <div className={`tts-engine-choice ${!settings.ttsEnabled ? "is-disabled" : ""}`}>
          <label><input type="radio" name="ttsEngine" disabled={!settings.ttsEnabled} checked={settings.ttsEngine === "silero"} onChange={() => update("ttsEngine", "silero")} /> Silero (локальный, офлайн, рекомендуется)</label>
          <label><input type="radio" name="ttsEngine" disabled={!settings.ttsEnabled} checked={settings.ttsEngine === "piper"} onChange={() => update("ttsEngine", "piper")} /> Piper (локальный, офлайн)</label>
          <label><input type="radio" name="ttsEngine" disabled={!settings.ttsEnabled} checked={settings.ttsEngine === "system"} onChange={() => update("ttsEngine", "system")} /> Системный голос</label>
        </div>
        {settings.ttsEnabled && settings.ttsEngine === "silero" && <>
          <label>Голос
            <select
              value={settings.sileroVoice}
              onChange={(event) => update("sileroVoice", event.target.value as SileroVoice)}
            >
              {SILERO_VOICES.map(({ value, label }) => <option key={value} value={value}>{label}</option>)}
            </select>
          </label>
          <button
            type="button"
            className="button"
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
                ? `Silero недоступен, читаем через Piper/системный голос: ${sileroStatus.lastError ?? "неизвестная ошибка"}`
                : "Silero: ожидание первого сообщения"}
          </p>
          <p className="tts-license-note">
            Silero <code>v5_5_ru</code> (<a href="https://github.com/snakers4/silero-models/blob/master/LICENSE" target="_blank" rel="noreferrer">CC BY-NC-SA 4.0, некоммерческая лицензия</a>) — используется только пока Companion остаётся некоммерческим продуктом. Запускается отдельным процессом (Python + PyTorch), не встроен в приложение. При недоступности автоматически переключаемся на Piper, затем на системный голос.
          </p>
        </>}
        {settings.ttsEnabled && settings.ttsEngine === "piper" && <p className="tts-piper-status">
          {piperBusy || piperStatus?.state === "starting" ? "Piper: загрузка/запуск…"
            : piperStatus?.state === "ready" ? "Piper: готов"
            : piperStatus?.state === "crashed" || piperStatus?.state === "unavailable"
              ? `Piper недоступен, читаем системным голосом: ${piperStatus.lastError ?? "неизвестная ошибка"}`
              : "Piper: ожидание первого сообщения"}
        </p>}
        {settings.ttsEnabled && settings.ttsEngine === "piper" && <p className="tts-license-note">
          Piper и <a href="https://github.com/espeak-ng/espeak-ng" target="_blank" rel="noreferrer">espeak-ng</a> (GPL-3.0, запускаются отдельным процессом, исходники: <a href="https://github.com/OHF-Voice/piper1-gpl" target="_blank" rel="noreferrer">OHF-Voice/piper1-gpl</a>), голос ru_RU-dmitri-medium (MIT/CC0).
        </p>}
        <label className={!settings.ttsEnabled ? "is-disabled" : ""}><input type="checkbox" disabled={!settings.ttsEnabled} checked={settings.speakAuthor} onChange={(event) => update("speakAuthor", event.target.checked)} /> Произносить имя автора</label>
        <label className={!settings.ttsEnabled ? "is-disabled" : ""}>Максимальная длина
          <select disabled={!settings.ttsEnabled} value={settings.maxLength} onChange={(event) => update("maxLength", Number(event.target.value))}>
            <option value={80}>80 символов</option><option value={180}>180 символов</option><option value={300}>300 символов</option>
          </select>
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
        <button className="button" onClick={stopTts} disabled={!settings.ttsEnabled && !isSpeaking()}>Остановить и выключить TTS</button>
      </aside>
    </div>
  </section>;
}
