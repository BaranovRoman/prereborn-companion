import { useEffect, useRef, useState } from "react";
import { BoundedTtsQueue, DEFAULT_CHAT_SETTINGS, nextUnreadCount, type ChatSettings } from "../chat/chat-model";
import {
  diagnosticsTraceTtsFrontend, getPiperTtsStatus, getTwitchChat, openTwitchSettings, setPiperTtsEnabled,
  synthesizePiperTts, type PiperTtsStatus, type TwitchChatMessage, type TwitchChatStatus,
} from "../services/dotaCompanionApi";

// TTS pipeline diagnostics trace (see diagnostics_trace_tts_frontend /
// diagnostics/tts_trace.rs) - one entry per in-flight message, from the
// moment it's enqueued for speech until playback ends, when it's flushed
// and removed. `stages` holds performance.now() timestamps under the exact
// names requested for the latency investigation (receivedAt, queuedAt,
// drainPickedAt, synthesisRequestedAt, audioReadyAt, playbackRequestedAt,
// actualPlaybackStartedAt, playbackEndedAt); `detail` is free-form context
// (queue sizes, which engine, text length, seconds since the previous
// message). Capped like the file's other per-message maps (`known`, `seen`
// in chat-model.ts) so an edge case (a message queued then evicted as stale
// before ever draining) can't leak unbounded entries.
interface TtsTraceBuilder { stages: Record<string, number>; detail: Record<string, unknown> }
const MAX_TRACE_ENTRIES = 200;

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
  const [piperStatus, setPiperStatus] = useState<PiperTtsStatus | null>(null);
  const [piperBusy, setPiperBusy] = useState(false);
  // HTMLAudioElement currently playing a Piper clip, if any - stopTts()
  // needs to pause it directly (unlike speechSynthesis, there's no global
  // "cancel" for it). `generation` is bumped on every stop so an
  // already-in-flight synthesize() result that resolves afterward is
  // discarded instead of starting playback the user just stopped.
  const currentAudio = useRef<HTMLAudioElement | null>(null);
  const generation = useRef(0);
  const traces = useRef(new Map<string, TtsTraceBuilder>());
  const lastPlaybackEndedAt = useRef<number | null>(null);

  const refreshPiperStatus = async () => {
    try { setPiperStatus(await getPiperTtsStatus()); }
    catch { /* transient IPC hiccup - next poll/attempt will retry */ }
  };

  const traceFor = (id: string): TtsTraceBuilder => {
    let entry = traces.current.get(id);
    if (!entry) {
      entry = { stages: {}, detail: {} };
      traces.current.set(id, entry);
      while (traces.current.size > MAX_TRACE_ENTRIES) {
        const oldest = traces.current.keys().next().value;
        if (oldest) traces.current.delete(oldest);
      }
    }
    return entry;
  };

  // Fire-and-forget by design: the diagnostics IPC round-trip must never be
  // awaited on the TTS critical path, or the instrumentation would add the
  // exact kind of latency it's supposed to be measuring.
  const flushTrace = (messageId: string, trace: TtsTraceBuilder) => {
    traces.current.delete(messageId);
    void diagnosticsTraceTtsFrontend({
      messageId,
      engine: typeof trace.detail.engine === "string" ? trace.detail.engine : undefined,
      stages: trace.stages,
      detail: trace.detail,
    }).catch(() => { /* diagnostics session likely inactive/transient IPC hiccup - non-fatal */ });
  };

  const speakWithSystem = (text: string, trace: TtsTraceBuilder, done: () => void) => {
    if (!("speechSynthesis" in window)) return done();
    if (trace.detail.engine === undefined) trace.detail.engine = "system";
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = "ru-RU";
    trace.stages.audioReadyAt = performance.now();
    utterance.onstart = () => { trace.stages.actualPlaybackStartedAt = performance.now(); };
    utterance.onend = done;
    utterance.onerror = done;
    trace.stages.playbackRequestedAt = performance.now();
    window.speechSynthesis.speak(utterance);
  };

  const speakWithPiper = async (text: string, messageId: string, trace: TtsTraceBuilder, done: () => void) => {
    const myGeneration = generation.current;
    trace.stages.synthesisRequestedAt = performance.now();
    try {
      const base64 = await synthesizePiperTts(text, messageId);
      trace.detail.engine = "piper";
      void refreshPiperStatus();
      if (myGeneration !== generation.current) return done();
      const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bytes], { type: "audio/wav" }));
      trace.stages.audioReadyAt = performance.now();
      const audio = new Audio(url);
      currentAudio.current = audio;
      const cleanup = () => {
        URL.revokeObjectURL(url);
        if (currentAudio.current === audio) currentAudio.current = null;
        done();
      };
      audio.onended = cleanup;
      audio.onerror = cleanup;
      audio.onplaying = () => {
        if (trace.stages.actualPlaybackStartedAt === undefined) trace.stages.actualPlaybackStartedAt = performance.now();
      };
      trace.stages.playbackRequestedAt = performance.now();
      await audio.play().catch(cleanup);
    } catch {
      // Piper unavailable/crashed for this message - read it with the
      // system voice instead of dropping it silently.
      trace.detail.engine = "piper-fallback-system";
      void refreshPiperStatus();
      if (myGeneration !== generation.current) return done();
      speakWithSystem(text, trace, done);
    }
  };

  const drainTts = () => {
    if (speaking.current || !settingsRef.current.ttsEnabled) return;
    const next = queue.current.takeNext();
    if (!next) return;
    const { id: messageId, text } = next;
    speaking.current = true;
    const trace = traceFor(messageId);
    trace.stages.drainPickedAt = performance.now();
    trace.detail.queueSizeAfterDrainPick = queue.current.size;
    trace.detail.secondsSincePreviousTts =
      lastPlaybackEndedAt.current !== null ? (performance.now() - lastPlaybackEndedAt.current) / 1000 : null;
    const done = () => {
      trace.stages.playbackEndedAt = performance.now();
      lastPlaybackEndedAt.current = trace.stages.playbackEndedAt;
      speaking.current = false;
      flushTrace(messageId, trace);
      drainTts();
    };
    if (settingsRef.current.ttsEngine === "piper") void speakWithPiper(text, messageId, trace, done);
    else speakWithSystem(text, trace, done);
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
      generation.current += 1;
      queue.current.clear();
      speaking.current = false;
      window.speechSynthesis?.cancel();
      if (currentAudio.current) { currentAudio.current.pause(); currentAudio.current = null; }
      // Messages still mid-flight (queued/drained but not yet finished) never
      // reach done()/flushTrace() when TTS is stopped mid-speech - drop their
      // half-built traces rather than leave them for the size cap to evict.
      traces.current.clear();
    }
  }, [settings]);

  const piperActive = settings.ttsEnabled && settings.ttsEngine === "piper";
  useEffect(() => {
    let active = true;
    setPiperBusy(true);
    setPiperTtsEnabled(piperActive)
      .then((next) => { if (active) setPiperStatus(next); })
      .catch((cause) => {
        if (active) setPiperStatus((prev) => prev
          ? { ...prev, state: "crashed", lastError: String(cause) }
          : { enabled: piperActive, state: "crashed", lastError: String(cause), resourcesReady: false });
      })
      .finally(() => { if (active) setPiperBusy(false); });
    return () => { active = false; };
  }, [piperActive]);

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
          for (const message of fresh) {
            const receivedAt = performance.now();
            const queued = queue.current.enqueue(message, settingsRef.current);
            if (!queued) continue;
            const trace = traceFor(message.id);
            // prepareTtsText/dedup run synchronously inside enqueue() above,
            // so receivedAt/filteredAt/queuedAt are all effectively the same
            // instant here - that's expected, they exist to prove text
            // filtering itself isn't where latency accumulates.
            trace.stages.receivedAt = receivedAt;
            trace.stages.filteredAt = receivedAt;
            trace.stages.queuedAt = performance.now();
            trace.detail.queueSizeAfterEnqueue = queue.current.size;
            trace.detail.wasSpeakingAtEnqueue = speaking.current;
            trace.detail.textLength = message.text.length;
          }
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
    generation.current += 1;
    setSettings((value) => ({ ...value, ttsEnabled: false }));
    queue.current.clear();
    speaking.current = false;
    window.speechSynthesis?.cancel();
    if (currentAudio.current) { currentAudio.current.pause(); currentAudio.current = null; }
  };
  const update = <K extends keyof ChatSettings>(key: K, value: ChatSettings[K]) =>
    setSettings((current) => ({ ...current, [key]: value }));

  const [reconnectPending, setReconnectPending] = useState(false);
  const reconnectTwitch = async () => {
    setReconnectPending(true);
    try { await openTwitchSettings(); }
    catch (cause) { setError(String(cause)); }
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
    {error && <p className="app__error">Чат временно недоступен: {error}</p>}
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
          <label><input type="radio" name="ttsEngine" disabled={!settings.ttsEnabled} checked={settings.ttsEngine === "system"} onChange={() => update("ttsEngine", "system")} /> Системный голос</label>
          <label><input type="radio" name="ttsEngine" disabled={!settings.ttsEnabled} checked={settings.ttsEngine === "piper"} onChange={() => update("ttsEngine", "piper")} /> Piper (локальный, офлайн)</label>
        </div>
        {piperActive && <p className="tts-piper-status">
          {piperBusy || piperStatus?.state === "starting" ? "Piper: загрузка/запуск…"
            : piperStatus?.state === "ready" ? "Piper: готов"
            : piperStatus?.state === "crashed" || piperStatus?.state === "unavailable"
              ? `Piper недоступен, читаем системным голосом: ${piperStatus.lastError ?? "неизвестная ошибка"}`
              : "Piper: ожидание первого сообщения"}
        </p>}
        {piperActive && <p className="tts-license-note">
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
        <button className="button" onClick={stopTts} disabled={!settings.ttsEnabled && !speaking.current}>Остановить и выключить TTS</button>
      </aside>
    </div>
  </section>;
}
