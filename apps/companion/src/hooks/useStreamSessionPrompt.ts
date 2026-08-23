import { useCallback, useEffect, useRef, useState } from "react";
import { getStreamSession, resetStreamSession } from "../services/dotaCompanionApi";
import { clearSessionAck, loadSessionAck, saveSessionAck } from "../session/session-ack-storage";
import { shouldShowSessionPrompt, type StreamSessionSummary } from "../session/session-prompt";

// WK-83 - runs once per app launch (mount-only effect). Tray minimize/
// restore only hides/shows the existing window (see lib.rs), it never
// remounts React, so this never re-fires on tray restore.
export function useStreamSessionPrompt() {
  const [promptData, setPromptData] = useState<StreamSessionSummary | null>(null);
  const [showPrompt, setShowPrompt] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busyRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    getStreamSession()
      .then((session) => {
        if (cancelled) return;
        setPromptData(session);
        setShowPrompt(shouldShowSessionPrompt(session, loadSessionAck(), Date.now()));
      })
      .catch((cause) => {
        // Backend unavailable at startup must never block the rest of
        // Companion (GSI/OBS/chat/TTS init already runs independently,
        // Rust-side) - just log and skip the prompt.
        console.warn("useStreamSessionPrompt: session fetch failed", cause);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const onContinue = useCallback(() => {
    if (!promptData) return;
    saveSessionAck({
      sessionId: promptData.id,
      sessionUpdatedAt: promptData.updatedAt,
      acknowledgedAt: new Date().toISOString(),
    });
    setShowPrompt(false);
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
      setShowPrompt(false);
    } catch (cause) {
      setError(String(cause));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, []);

  return { promptData, showPrompt, busy, error, onContinue, onStartNew };
}
