import { useEffect, useRef, useState } from "react";
import { BoundedTtsQueue, DEFAULT_CHAT_SETTINGS, nextUnreadCount, type ChatSettings } from "../chat/chat-model";
import { getTwitchChat, type TwitchChatMessage, type TwitchChatStatus } from "../services/dotaCompanionApi";

const STORAGE_KEY = "companion-twitch-chat-settings-v1";
const loadSettings = (): ChatSettings => {
  try { return { ...DEFAULT_CHAT_SETTINGS, ...JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") }; }
  catch { return DEFAULT_CHAT_SETTINGS; }
};

export function TwitchChatPage() {
  const [status, setStatus] = useState<TwitchChatStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [settings, setSettings] = useState(loadSettings);
  const [unread, setUnread] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const initialized = useRef(false);
  const known = useRef(new Set<string>());
  const queue = useRef(new BoundedTtsQueue());
  const speaking = useRef(false);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  const drainTts = () => {
    if (speaking.current || !settingsRef.current.ttsEnabled || !("speechSynthesis" in window)) return;
    const text = queue.current.takeNext();
    if (!text) return;
    speaking.current = true;
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = "ru-RU";
    const done = () => { speaking.current = false; drainTts(); };
    utterance.onend = done;
    utterance.onerror = done;
    window.speechSynthesis.speak(utterance);
  };

  const beep = () => {
    const Context = window.AudioContext;
    if (!Context) return;
    const context = new Context();
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.frequency.value = 740;
    gain.gain.setValueAtTime(0.08, context.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, context.currentTime + 0.12);
    oscillator.connect(gain).connect(context.destination);
    oscillator.start();
    oscillator.stop(context.currentTime + 0.12);
    oscillator.onended = () => void context.close();
  };

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    if (!settings.ttsEnabled) {
      queue.current.clear();
      speaking.current = false;
      window.speechSynthesis?.cancel();
    }
  }, [settings]);

  useEffect(() => {
    let active = true;
    const poll = async () => {
      try {
        const next = await getTwitchChat();
        if (!active) return;
        const fresh = initialized.current
          ? next.messages.filter((message) => !known.current.has(message.id))
          : [];
        next.messages.forEach((message) => known.current.add(message.id));
        while (known.current.size > 160) {
          const id = known.current.values().next().value;
          if (id) known.current.delete(id);
        }
        initialized.current = true;
        if (fresh.length) {
          setUnread((current) => nextUnreadCount(current, atBottom.current, fresh.length));
          if (settingsRef.current.soundEnabled) beep();
          for (const message of fresh) queue.current.enqueue(message, settingsRef.current);
          drainTts();
        }
        setStatus(next);
        setError(null);
      } catch (cause) {
        if (active) setError(String(cause));
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 1500);
    return () => { active = false; window.clearInterval(timer); };
  }, []);

  useEffect(() => {
    if (atBottom.current) listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [status?.messages.length]);

  const onScroll = () => {
    const element = listRef.current;
    if (!element) return;
    atBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 32;
    if (atBottom.current) setUnread(0);
  };
  const toLatest = () => {
    const element = listRef.current;
    if (element) element.scrollTo({ top: element.scrollHeight, behavior: "smooth" });
    atBottom.current = true;
    setUnread(0);
  };
  const stopTts = () => {
    setSettings((value) => ({ ...value, ttsEnabled: false }));
    queue.current.clear();
    speaking.current = false;
    window.speechSynthesis?.cancel();
  };
  const update = <K extends keyof ChatSettings>(key: K, value: ChatSettings[K]) =>
    setSettings((current) => ({ ...current, [key]: value }));

  const messages: TwitchChatMessage[] = status?.messages ?? [];
  const label = !status?.accountConnected
    ? "Twitch не подключён в веб-кабинете"
    : status.connected ? "Чат подключён" : "Восстанавливаем подключение…";

  return <section className="chat-page">
    <div className="chat-page__header">
      <div><span className="section-heading__eyebrow">Не пропускайте зрителей</span><h2>Twitch-чат</h2><p>{status?.displayName ? `${status.displayName} · ${label}` : label}</p></div>
      <span className={`connection-pill ${status?.connected ? "is-online" : ""}`}>{status?.connected ? "На связи" : "Ожидание"}</span>
    </div>
    {error && <p className="app__error">Чат временно недоступен: {error}</p>}
    <div className="chat-layout">
      <div className="chat-stream">
        <div className="chat-messages" ref={listRef} onScroll={onScroll} aria-live="polite">
          {!messages.length && <div className="chat-empty">{status?.accountConnected ? "Новые сообщения появятся здесь." : "Подключите Twitch в веб-кабинете PreReborn."}</div>}
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
        <label className={!settings.ttsEnabled ? "is-disabled" : ""}><input type="checkbox" disabled={!settings.ttsEnabled} checked={settings.speakAuthor} onChange={(event) => update("speakAuthor", event.target.checked)} /> Произносить имя автора</label>
        <label className={!settings.ttsEnabled ? "is-disabled" : ""}>Максимальная длина
          <select disabled={!settings.ttsEnabled} value={settings.maxLength} onChange={(event) => update("maxLength", Number(event.target.value))}>
            <option value={80}>80 символов</option><option value={180}>180 символов</option><option value={300}>300 символов</option>
          </select>
        </label>
        <p>TTS выключен по умолчанию. Ссылки, системные события и явный спам не читаются.</p>
        <button className="button" onClick={stopTts} disabled={!settings.ttsEnabled && !speaking.current}>Остановить и выключить TTS</button>
      </aside>
    </div>
  </section>;
}
