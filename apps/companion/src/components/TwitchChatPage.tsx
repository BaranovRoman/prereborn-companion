import { useEffect, useRef, useState } from "react";
import type { TwitchChatSession } from "../chat/useTwitchChatSession";
import { openStreamSettings, type TwitchChatMessage } from "../services/dotaCompanionApi";

// WK-78 - polling, dedup, the TTS queue/playback and unread counting used to
// live here and stopped the moment this page unmounted (e.g. switching to
// another tab). All of that now lives in useTwitchChatSession, owned once at
// the app root (HomePage) - this component is just a UI consumer of it.
//
// WK-121 §4 - Settings ownership audit: every PERMANENT TTS/chat preference
// (enable, engine, voice, volume, speak-author, max length, pronunciation,
// notification sound) moved to Settings → "Чат и TTS" (ChatTtsSettings.tsx,
// same session instance, not a second copy of the state). This screen keeps
// only runtime concerns: the message stream, Twitch connection state, and
// the skip/stop TTS actions - a working runtime screen, not a settings form.
export function TwitchChatPage({ session, onOpenChatSettings }: { session: TwitchChatSession; onOpenChatSettings: () => void }) {
  const {
    status, error, unread, settings, stopTts, isSpeaking, setViewerAtBottom, markRead,
    skipTts, lastSkipAt,
  } = session;
  const listRef = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);

  // Purely visual "Озвучка пропущена" note - never a sound (Companion's TTS
  // is heard over Desktop Audio in OBS, see the WK-83 feature report) and
  // never routed into any overlay, just this in-app fade.
  const [showSkipToast, setShowSkipToast] = useState(false);
  useEffect(() => {
    if (lastSkipAt === null) return;
    setShowSkipToast(true);
    const timer = window.setTimeout(() => setShowSkipToast(false), 1800);
    return () => window.clearTimeout(timer);
  }, [lastSkipAt]);

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
  const [reconnectPending, setReconnectPending] = useState(false);
  const [reconnectError, setReconnectError] = useState<string | null>(null);
  const reconnectTwitch = async () => {
    setReconnectPending(true);
    try { await openStreamSettings(); }
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
      {/* Silent by design - see the WK-83 feature report: Companion's TTS is
          heard over Desktop Audio in OBS, so Skip must never itself make a
          sound. This is a purely visual note, never routed into any overlay. */}
      {showSkipToast && <span className="tts-skip-toast" aria-live="polite">Озвучка пропущена</span>}
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
      {/* WK-121 - runtime-only sidebar: TTS queue/status + skip/stop actions.
          Every permanent preference moved to Settings → "Чат и TTS" - see
          this component's top doc comment. */}
      <aside className="chat-settings chat-settings--runtime">
        <h3>TTS</h3>
        <p className="chat-runtime-panel__status">
          {!settings.ttsEnabled ? "Озвучка выключена" : isSpeaking() ? "Озвучивает…" : "Ожидание сообщений"}
        </p>
        <div className="tts-buttons">
          <button className="button" onClick={skipTts} disabled={!isSpeaking()}>Пропустить текущую озвучку</button>
          <button className="button" onClick={stopTts} disabled={!settings.ttsEnabled && !isSpeaking()}>Остановить и выключить TTS</button>
        </div>
        <button type="button" className="link-button" onClick={onOpenChatSettings}>Настройки чата и TTS →</button>
      </aside>
    </div>
  </section>;
}
