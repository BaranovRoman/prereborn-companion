import { useCallback, useEffect, useRef, useState } from "react";
import { BoundedTtsQueue, DEFAULT_CHAT_SETTINGS, nextUnreadCount, type ChatSettings } from "./chat-model";
import {
  diagnosticsTraceTtsFrontend, getPiperTtsStatus, getSileroTtsStatus, getTwitchChat, setPiperTtsEnabled,
  setSileroTtsEnabled, synthesizePiperTts, synthesizeSileroTts, type PiperTtsStatus, type SileroTtsStatus,
  type SileroVoice, type TwitchChatStatus,
} from "../services/dotaCompanionApi";

// Short, fixed conversational phrase for the settings page's "Прослушать"
// preview button (WK-81) - deliberately not user-editable text, so preview
// always exercises the same, representative synthesis.
export const SILERO_PREVIEW_PHRASE = "го дальше, потом фарм, го вп го";

// WK-78 - this used to live entirely inside TwitchChatPage.tsx, so the
// EventSub poll loop, dedup, unread counter and TTS queue/playback all
// stopped the instant the Chat tab was closed (the setInterval was cleared
// on unmount), even though the backend kept buffering messages. Hoisted
// here and instantiated once at the app root (HomePage) so chat delivery
// and TTS keep running regardless of which tab is visible - TwitchChatPage
// is now just a UI consumer of this session, not its owner.

interface TtsTraceBuilder { stages: Record<string, number>; detail: Record<string, unknown> }
const MAX_TRACE_ENTRIES = 200;

const STORAGE_KEY = "companion-twitch-chat-settings-v1";
const loadSettings = (): ChatSettings => {
  try { return { ...DEFAULT_CHAT_SETTINGS, ...JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") }; }
  catch { return DEFAULT_CHAT_SETTINGS; }
};

export interface TwitchChatSession {
  status: TwitchChatStatus | null;
  error: string | null;
  unread: number;
  settings: ChatSettings;
  piperStatus: PiperTtsStatus | null;
  piperBusy: boolean;
  sileroStatus: SileroTtsStatus | null;
  sileroBusy: boolean;
  previewBusy: boolean;
  previewError: string | null;
  previewSileroVoice: (voice: SileroVoice) => void;
  updateSetting: <K extends keyof ChatSettings>(key: K, value: ChatSettings[K]) => void;
  stopTts: () => void;
  isSpeaking: () => boolean;
  setViewerAtBottom: (atBottom: boolean) => void;
  markRead: () => void;
}

export function useTwitchChatSession(): TwitchChatSession {
  const [status, setStatus] = useState<TwitchChatStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [settings, setSettings] = useState(loadSettings);
  const [unread, setUnread] = useState(0);
  const [piperStatus, setPiperStatus] = useState<PiperTtsStatus | null>(null);
  const [piperBusy, setPiperBusy] = useState(false);
  const [sileroStatus, setSileroStatus] = useState<SileroTtsStatus | null>(null);
  const [sileroBusy, setSileroBusy] = useState(false);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);

  const initialized = useRef(false);
  const known = useRef(new Set<string>());
  const queue = useRef(new BoundedTtsQueue());
  const speaking = useRef(false);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  // Nobody is looking at the Chat tab until it mounts and says otherwise
  // (see TwitchChatPage's setViewerAtBottom calls) - so messages that
  // arrive before the tab is ever opened count toward unread, not silently
  // marked read.
  const viewerAtBottom = useRef(false);
  const currentAudio = useRef<HTMLAudioElement | null>(null);
  const generation = useRef(0);
  const traces = useRef(new Map<string, TtsTraceBuilder>());
  const lastPlaybackEndedAt = useRef<number | null>(null);

  const refreshPiperStatus = useCallback(async () => {
    try { setPiperStatus(await getPiperTtsStatus()); }
    catch { /* transient IPC hiccup - next poll/attempt will retry */ }
  }, []);

  const refreshSileroStatus = useCallback(async () => {
    try { setSileroStatus(await getSileroTtsStatus()); }
    catch { /* transient IPC hiccup - next poll/attempt will retry */ }
  }, []);

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

  const speakWithPiper = async (
    text: string,
    messageId: string,
    trace: TtsTraceBuilder,
    done: () => void,
    engineLabel: string = "piper",
  ) => {
    const myGeneration = generation.current;
    trace.stages.synthesisRequestedAt = performance.now();
    try {
      const base64 = await synthesizePiperTts(text, messageId);
      trace.detail.engine = engineLabel;
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
      trace.detail.engine = `${engineLabel}-fallback-system`;
      void refreshPiperStatus();
      if (myGeneration !== generation.current) return done();
      speakWithSystem(text, trace, done);
    }
  };

  // WK-81 fallback chain: Silero (primary) -> Piper -> system speechSynthesis.
  // Each engine's own catch block below hands off to the next one on
  // failure rather than dropping the message - the queue/generation/done()
  // contract is identical regardless of which engine actually ends up
  // speaking a given message.
  const speakWithSilero = async (text: string, messageId: string, trace: TtsTraceBuilder, done: () => void) => {
    const myGeneration = generation.current;
    const voice = settingsRef.current.sileroVoice;
    trace.stages.synthesisRequestedAt = performance.now();
    try {
      const base64 = await synthesizeSileroTts(text, voice, messageId);
      trace.detail.engine = `silero-${voice}`;
      void refreshSileroStatus();
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
      // Silero unavailable/crashed/cooling down for this message - fall
      // back to Piper rather than dropping it silently. Piper's own catch
      // falls back to system speechSynthesis in turn.
      void refreshSileroStatus();
      if (myGeneration !== generation.current) return done();
      void speakWithPiper(text, messageId, trace, done, "silero-fallback-piper");
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
    if (settingsRef.current.ttsEngine === "silero") void speakWithSilero(text, messageId, trace, done);
    else if (settingsRef.current.ttsEngine === "piper") void speakWithPiper(text, messageId, trace, done);
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

  // Piper stays enabled whenever Silero is the active engine too, since
  // Silero's own fallback chain needs Piper's resources/sidecar ready to
  // actually fall back to it rather than skipping straight to system TTS.
  const piperActive = settings.ttsEnabled && (settings.ttsEngine === "piper" || settings.ttsEngine === "silero");
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

  const sileroActive = settings.ttsEnabled && settings.ttsEngine === "silero";
  useEffect(() => {
    let active = true;
    setSileroBusy(true);
    setSileroTtsEnabled(sileroActive)
      .then((next) => { if (active) setSileroStatus(next); })
      .catch((cause) => {
        if (active) setSileroStatus((prev) => prev
          ? { ...prev, state: "crashed", lastError: String(cause) }
          : { enabled: sileroActive, state: "crashed", lastError: String(cause), resourcesReady: false, voice: settingsRef.current.sileroVoice });
      })
      .finally(() => { if (active) setSileroBusy(false); });
    return () => { active = false; };
  }, [sileroActive]);

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
          setUnread((current) => nextUnreadCount(current, viewerAtBottom.current, fresh.length));
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
    // In-flight guard (WK-78): skip a tick instead of firing another
    // getTwitchChat() while the previous one is still awaiting the backend -
    // a hanging/slow backend used to let overlapping 5s-timeout requests
    // stack up every 1.5s.
    let inFlight = false;
    const timer = window.setInterval(() => {
      if (inFlight) return;
      inFlight = true;
      void poll().finally(() => { inFlight = false; });
    }, 1500);
    return () => { active = false; window.clearInterval(timer); };
  }, []);

  const updateSetting = useCallback(<K extends keyof ChatSettings>(key: K, value: ChatSettings[K]) => {
    setSettings((current) => ({ ...current, [key]: value }));
  }, []);

  const stopTts = useCallback(() => {
    generation.current += 1;
    setSettings((value) => ({ ...value, ttsEnabled: false }));
    queue.current.clear();
    speaking.current = false;
    window.speechSynthesis?.cancel();
    if (currentAudio.current) { currentAudio.current.pause(); currentAudio.current = null; }
  }, []);

  const isSpeaking = useCallback(() => speaking.current, []);

  const setViewerAtBottom = useCallback((atBottom: boolean) => {
    viewerAtBottom.current = atBottom;
  }, []);

  const markRead = useCallback(() => setUnread(0), []);

  // Settings-page "Прослушать" button (WK-81) - synthesizes the fixed
  // preview phrase with an explicit voice (independent of the currently
  // saved sileroVoice setting, so a user can audition a voice before
  // committing to it) and plays it directly, outside the chat queue.
  //
  // Bug fix: this used to never call refreshSileroStatus() on either branch,
  // unlike speakWithSilero (which does on both success and failure) - the
  // settings-page status line is driven entirely by sileroStatus, so a user
  // who only ever clicked "Прослушать" (never actually had a chat message
  // spoken) saw it frozen on the "waiting for first message" default
  // forever, with zero feedback either way: a successful preview played
  // audio but never updated the label, and a failed one was swallowed
  // silently by `.catch(() => setPreviewBusy(false))` with no visible error
  // at all - indistinguishable from the button "doing nothing".
  const previewSileroVoice = useCallback((voice: SileroVoice) => {
    setPreviewBusy(true);
    setPreviewError(null);
    synthesizeSileroTts(SILERO_PREVIEW_PHRASE, voice)
      .then((base64) => {
        void refreshSileroStatus();
        const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
        const url = URL.createObjectURL(new Blob([bytes], { type: "audio/wav" }));
        const audio = new Audio(url);
        currentAudio.current = audio;
        const cleanup = () => {
          URL.revokeObjectURL(url);
          if (currentAudio.current === audio) currentAudio.current = null;
          setPreviewBusy(false);
        };
        audio.onended = cleanup;
        audio.onerror = cleanup;
        void audio.play().catch(cleanup);
      })
      .catch((cause) => {
        void refreshSileroStatus();
        setPreviewError(String(cause));
        setPreviewBusy(false);
      });
  }, [refreshSileroStatus]);

  return {
    status, error, unread, settings, piperStatus, piperBusy, sileroStatus, sileroBusy, previewBusy, previewError,
    previewSileroVoice, updateSetting, stopTts, isSpeaking, setViewerAtBottom, markRead,
  };
}
