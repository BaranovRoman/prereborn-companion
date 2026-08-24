import { useCallback, useEffect, useRef, useState } from "react";
import { endStreamSession, getStreamSession, resetStreamSession } from "../services/dotaCompanionApi";
import { clearSessionAck, loadSessionAck, saveSessionAck } from "../session/session-ack-storage";
import { getSessionPromptMode, type SessionPromptMode, type StreamSessionSummary } from "../session/session-prompt";

// Companion UI 2.0 follow-up - single source of truth for this hook's
// return shape, imported by both StreamSessionCard.tsx and pages/
// HomePage.tsx instead of each declaring its own copy of the same slice
// (a prior self-review pass found those two copies had already drifted
// once and could silently drift again).
export interface StreamSessionPromptState {
  promptData: StreamSessionSummary | null;
  promptMode: SessionPromptMode;
  showPrompt: boolean;
  busy: boolean;
  error: string | null;
  onContinue: () => void;
  onStartNew: () => Promise<void>;
  onEndStream: () => Promise<void>;
  refresh: () => Promise<void>;
}

// WK-83/WK-53 - the initial fetch runs once per app launch (mount-only
// effect). Tray minimize/restore only hides/shows the existing window (see
// lib.rs), it never remounts React, so this never re-fires on tray restore.
export function useStreamSessionPrompt(): StreamSessionPromptState {
  const [promptData, setPromptData] = useState<StreamSessionSummary | null>(null);
  const [promptMode, setPromptMode] = useState<SessionPromptMode>("hidden");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busyRef = useRef(false);

  // Companion UI 2.0 follow-up - factored out of the mount effect so it can
  // also serve as a manual retry (see StreamSessionCard's "Обновить" action
  // in the "unavailable" state). Before this, a failed initial fetch (e.g.
  // no companion token yet) had no way to recover short of restarting the
  // whole app, even after the user fixed the underlying problem (e.g. saved
  // a token in Настройки) - a self-review finding on the always-visible
  // StreamSessionCard this hook now feeds.
  const refresh = useCallback(async () => {
    try {
      const session = await getStreamSession();
      setPromptData(session);
      setError(null);
      setPromptMode(getSessionPromptMode(session, loadSessionAck(), Date.now()));
    } catch (cause) {
      // Backend unavailable must never block the rest of Companion (GSI/
      // OBS/chat/TTS init already runs independently, Rust-side) - the
      // stale-session BANNER simply stays hidden (promptMode untouched).
      // `error` still needs to be set: the always-visible StreamSessionCard
      // (see pages/HomePage.tsx) reads it to tell "still loading" apart
      // from "genuinely unavailable" (задача state D).
      console.warn("useStreamSessionPrompt: session fetch failed", cause);
      setError(String(cause));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const onContinue = useCallback(() => {
    // WK-53 - "Продолжить" is meaningless (and never offered by the UI, see
    // SessionPromptBanner) once the session has been explicitly ended.
    if (!promptData || promptData.state === "ended") return;
    saveSessionAck({
      sessionId: promptData.id,
      sessionUpdatedAt: promptData.updatedAt,
      acknowledgedAt: new Date().toISOString(),
    });
    setPromptMode("hidden");
  }, [promptData]);

  const onStartNew = useCallback(async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      const session = await resetStreamSession();
      clearSessionAck();
      setPromptData(session);
      setPromptMode("hidden");
    } catch (cause) {
      setError(String(cause));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, []);

  // WK-100 - "Завершить стрим" from Companion's main screen. Reuses the same
  // busy/error state machine as onStartNew above. On success, promptData/
  // promptMode are updated the same way a fresh getStreamSession() fetch
  // would report an explicitly-ended session (state "ended" ->
  // getSessionPromptMode returns "endedNewOnly") - this reuses the EXISTING
  // SessionPromptBanner "Стрим завершён / Начать новый стрим" UI as the
  // confirmation, rather than a second bespoke "ended" banner. On failure,
  // promptData/promptMode are left untouched - a backend error must never
  // move the UI into a false "ended" state (see задача, п. A).
  const onEndStream = useCallback(async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      const session = await endStreamSession();
      setPromptData(session);
      setPromptMode(getSessionPromptMode(session, loadSessionAck(), Date.now()));
    } catch (cause) {
      setError(String(cause));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, []);

  return {
    promptData,
    promptMode,
    showPrompt: promptMode !== "hidden",
    busy,
    error,
    onContinue,
    onStartNew,
    onEndStream,
    refresh,
  };
}
