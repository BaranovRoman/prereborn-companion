import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { BoundedTtsQueue, DEFAULT_CHAT_SETTINGS, nextUnreadCount, type ChatSettings } from "./chat-model";
import {
  diagnosticsTraceTtsFrontend, getSileroTtsStatus, getSkipHotkeyStatus, getTwitchChat,
  setSileroTtsEnabled, setSkipHotkey, synthesizeSileroTts,
  type SileroTtsStatus, type SileroVoice, type SkipHotkeyStatus, type TwitchChatStatus,
} from "../services/dotaCompanionApi";

// Short, fixed conversational phrase for the settings page's "Прослушать"
// preview button (WK-81) - deliberately not user-editable text, so preview
// always exercises the same, representative synthesis.
export const SILERO_PREVIEW_PHRASE = "го дальше, потом фарм, го вп го";

// Global "skip current TTS" hotkey (WK-83, see src-tauri/src/hotkeys.rs) -
// the Rust side only registers the OS-level combo and emits this event on
// press; everything about *how* to skip (stop playback, cancel an
// in-flight synthesis without killing the sidecar, never make a sound)
// lives here, since this is the only place that holds the playback state
// needed to do it safely (currentAudio, generation, the queue itself).
const SKIP_TTS_EVENT = "hotkeys://skip-tts";

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
  try {
    const merged = { ...DEFAULT_CHAT_SETTINGS, ...JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") };
    // WK-80 - Piper was removed; a settings blob saved by an older
    // Companion version may still have ttsEngine: "piper" persisted. Coerce
    // it to "silero" (already the recommended engine) rather than leaving a
    // value neither the settings UI nor drainTts's dispatch recognizes
    // anymore, which would otherwise silently stop speaking messages for
    // exactly the users who had explicitly opted into Piper.
    if ((merged.ttsEngine as string) === "piper") merged.ttsEngine = "silero";
    return merged;
  }
  catch { return DEFAULT_CHAT_SETTINGS; }
};

export interface TwitchChatSession {
  status: TwitchChatStatus | null;
  error: string | null;
  unread: number;
  settings: ChatSettings;
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
  // Skip-current-TTS hotkey (WK-83).
  skipTts: () => void;
  lastSkipAt: number | null;
  skipHotkeyStatus: SkipHotkeyStatus | null;
  skipHotkeyBusy: boolean;
  updateSkipHotkey: (enabled: boolean, shortcut: string) => Promise<void>;
}

export function useTwitchChatSession(): TwitchChatSession {
  const [status, setStatus] = useState<TwitchChatStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [settings, setSettings] = useState(loadSettings);
  const [unread, setUnread] = useState(0);
  const [sileroStatus, setSileroStatus] = useState<SileroTtsStatus | null>(null);
  const [sileroBusy, setSileroBusy] = useState(false);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [skipHotkeyStatus, setSkipHotkeyStatus] = useState<SkipHotkeyStatus | null>(null);
  const [skipHotkeyBusy, setSkipHotkeyBusy] = useState(false);
  const [lastSkipAt, setLastSkipAt] = useState<number | null>(null);

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
  // Set only once the currently-speaking entry has something actually
  // cancellable (audio already created, or a system-voice utterance already
  // dispatched) - null while a message is still awaiting synthesis over IPC,
  // in which case skipTts() below only bumps `generation` and lets that
  // call's own generation check (already present in speakWithSilero)
  // discard the result once it resolves, instead of calling `done()` a
  // second time itself.
  const activeCancel = useRef<(() => void) | null>(null);

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
    // speechSynthesis.cancel() fires the utterance's own onerror (wired to
    // `done` above) - skipTts() below doesn't need to call done() itself
    // for this engine, just trigger the cancellation.
    activeCancel.current = () => window.speechSynthesis.cancel();
    trace.stages.playbackRequestedAt = performance.now();
    window.speechSynthesis.speak(utterance);
  };

  // WK-80 fallback chain: Silero (primary) -> system speechSynthesis (only
  // fallback, since Piper was removed). The catch block below hands off to
  // speakWithSystem on failure rather than dropping the message - the
  // queue/generation/done() contract is identical regardless of which
  // engine actually ends up speaking a given message.
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
      // Now cancellable - skipTts() pauses the audio directly (pause()
      // doesn't fire onended/onerror on its own) and runs the same
      // cleanup/done() path a natural end would.
      activeCancel.current = () => { audio.pause(); cleanup(); };
      trace.stages.playbackRequestedAt = performance.now();
      await audio.play().catch(cleanup);
    } catch {
      // Silero unavailable/crashed/cooling down for this message - fall
      // back to system speechSynthesis rather than dropping it silently.
      trace.detail.engine = "silero-fallback-system";
      void refreshSileroStatus();
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
    // Nothing cancellable yet - still (about to be) synthesizing. Each
    // speakWith* function sets this once it has something skipTts() can
    // actually act on (an Audio element or a dispatched system utterance).
    activeCancel.current = null;
    const trace = traceFor(messageId);
    trace.stages.drainPickedAt = performance.now();
    trace.detail.queueSizeAfterDrainPick = queue.current.size;
    trace.detail.secondsSincePreviousTts =
      lastPlaybackEndedAt.current !== null ? (performance.now() - lastPlaybackEndedAt.current) / 1000 : null;
    const done = () => {
      activeCancel.current = null;
      trace.stages.playbackEndedAt = performance.now();
      lastPlaybackEndedAt.current = trace.stages.playbackEndedAt;
      speaking.current = false;
      flushTrace(messageId, trace);
      drainTts();
    };
    if (settingsRef.current.ttsEngine === "silero") void speakWithSilero(text, messageId, trace, done);
    else speakWithSystem(text, trace, done);
  };

  // WK-83 - global "skip current TTS" hotkey handler (also used by the
  // settings-page "Пропустить" button). Never plays any audio/beep itself -
  // Companion's TTS goes out over Desktop Audio in OBS, so a sound here
  // would be heard by the whole stream; any feedback is purely visual (see
  // `lastSkipAt`, rendered as a transient on-screen note in TwitchChatPage).
  //
  // - Nothing speaking/synthesizing right now: no-op (queue/settings
  //   untouched).
  // - Audio already playing (or a system utterance already dispatched):
  //   stop it immediately via `activeCancel`, which itself calls `done()`
  //   and so advances straight to the next queued message.
  // - Still awaiting a Silero synthesis IPC call: only bumps
  //   `generation` - the sidecar keeps running (never killed here), and
  //   that in-flight call's own generation check (already in
  //   speakWithSilero) discards its result instead of
  //   playing it once it resolves, calling `done()` itself exactly once.
  //   This is also what makes rapid repeated presses safe: each press only
  //   ever triggers at most one `done()` call, either synchronously here or
  //   once by the in-flight call later, never both.
  const skipTts = useCallback(() => {
    if (!speaking.current) return;
    setLastSkipAt(Date.now());
    generation.current += 1;
    const cancel = activeCancel.current;
    activeCancel.current = null;
    cancel?.();
  }, []);

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
      activeCancel.current = null;
      window.speechSynthesis?.cancel();
      if (currentAudio.current) { currentAudio.current.pause(); currentAudio.current = null; }
      // Messages still mid-flight (queued/drained but not yet finished) never
      // reach done()/flushTrace() when TTS is stopped mid-speech - drop their
      // half-built traces rather than leave them for the size cap to evict.
      traces.current.clear();
    }
  }, [settings]);

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
    activeCancel.current = null;
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

  // WK-83 - loads the persisted skip-hotkey status once at startup (mirrors
  // the silero status effect above) and listens for the global
  // shortcut's press event for as long as the session is mounted (i.e. the
  // whole app lifetime, per the WK-78 hoisting rationale at the top of this
  // file) - the hotkey must keep working from any tab, not just Chat.
  useEffect(() => {
    let active = true;
    getSkipHotkeyStatus().then((next) => { if (active) setSkipHotkeyStatus(next); }).catch(() => { /* transient IPC hiccup */ });
    const unlistenPromise = listen(SKIP_TTS_EVENT, () => skipTts());
    return () => { active = false; void unlistenPromise.then((unlisten) => unlisten()); };
  }, [skipTts]);

  const updateSkipHotkey = useCallback(async (enabled: boolean, shortcut: string) => {
    setSkipHotkeyBusy(true);
    try {
      setSkipHotkeyStatus(await setSkipHotkey(enabled, shortcut));
    } catch (cause) {
      // A failed attempt never touches the previous working combo on the
      // Rust side (see hotkeys.rs's rollback) - refresh from there instead
      // of guessing at the resulting state ourselves.
      try { setSkipHotkeyStatus(await getSkipHotkeyStatus()); } catch { /* transient IPC hiccup */ }
      throw cause;
    } finally {
      setSkipHotkeyBusy(false);
    }
  }, []);

  return {
    status, error, unread, settings, sileroStatus, sileroBusy, previewBusy, previewError,
    previewSileroVoice, updateSetting, stopTts, isSpeaking, setViewerAtBottom, markRead,
    skipTts, lastSkipAt, skipHotkeyStatus, skipHotkeyBusy, updateSkipHotkey,
  };
}
