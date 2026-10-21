import { useEffect, useRef, useState } from "react";
import type { TwitchChatSession } from "../chat/useTwitchChatSession";
import { openStreamSettings, type TwitchChatMessage } from "../core/api";
import { Badge, Button, Notice } from "./ui";

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

  const speaking = isSpeaking();
  return <section className="chat-page">
    <div className="chat-page__status">
      <Badge tone={status?.connected ? "success" : reauthRequired ? "warning" : "default"} dot>
        {status?.connected ? "На связи" : reauthRequired ? "Нужен повторный вход" : "Ожидание"}
      </Badge>
      <span className="ui-text-soft">{status?.displayName ? `${status.displayName} · ${label}` : label}</span>
      {/* Silent by design - see the WK-83 feature report: Companion's TTS is
          heard over Desktop Audio in OBS, so Skip must never itself make a
          sound. This is a purely visual note, never routed into any overlay. */}
      {showSkipToast && <span className="tts-skip-toast" aria-live="polite">Озвучка пропущена</span>}
    </div>
    {(error || reconnectError) && <Notice tone="danger">Чат временно недоступен: {reconnectError ?? error}</Notice>}
    {reauthRequired && <Notice tone="warning" action={<Button size="small" variant="primary" onClick={reconnectTwitch} disabled={reconnectPending}>Открыть настройки Twitch</Button>}>
      Twitch нужно переподключить, чтобы получать сообщения чата. Это займёт минуту — откройте настройки и подключите Twitch заново.
    </Notice>}
    <div className="chat-layout">
      <div className="chat-stream">
        <div className="chat-messages" ref={listRef} onScroll={onScroll} aria-live="polite" aria-label="Сообщения чата" tabIndex={0}>
          {!messages.length && <div className="chat-empty">
            {reauthRequired
              ? "Сообщения не поступают, пока Twitch не переподключён."
              : status?.accountConnected ? "Новые сообщения появятся здесь." : "Подключите Twitch в Настройках → Интеграции."}
          </div>}
          {messages.map((message) => <article className="chat-message" key={message.id}>
            <time dateTime={message.receivedAt}>{new Date(message.receivedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time>
            <p><strong style={{ color: message.color || undefined }}>{message.author}</strong><span>{message.text}</span></p>
          </article>)}
        </div>
        {unread > 0 && <button className="chat-latest" onClick={toLatest}>{unread} новых · К последним ↓</button>}
      </div>
      {/* WK-121 - runtime-only sidebar: TTS queue/status + skip/stop actions.
          Every permanent preference lives in Озвучка - see this component's
          top doc comment. */}
      <aside className="chat-tts" aria-label="Озвучка чата">
        <div className="chat-tts__header">
          <h2>Озвучка</h2>
          <Badge tone={!settings.ttsEnabled ? "default" : speaking ? "accent" : "success"} dot={settings.ttsEnabled}>
            {!settings.ttsEnabled ? "Озвучка выключена" : speaking ? "Озвучивает…" : "Ожидание сообщений"}
          </Badge>
        </div>
        <div className="chat-tts__actions">
          <Button onClick={skipTts} disabled={!speaking}>Пропустить текущую озвучку</Button>
          <Button variant="danger" onClick={stopTts} disabled={!settings.ttsEnabled && !speaking}>Остановить и выключить TTS</Button>
        </div>
        <Button variant="link" className="chat-tts__settings" onClick={onOpenChatSettings}>Настройки чата и TTS →</Button>
      </aside>
    </div>
  </section>;
}
