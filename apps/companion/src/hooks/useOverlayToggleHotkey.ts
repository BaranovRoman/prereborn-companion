import { useCallback, useEffect, useState } from "react";
import { getOverlayToggleHotkeyStatus, setOverlayToggleHotkey, type OverlayToggleHotkeyStatus } from "../services/dotaCompanionApi";

// WK-135 - global "show/hide overlay" hotkey (primary control for WK-124's
// overlay visibility switch). Mirrors useTwitchChatSession.ts's skip-hotkey
// status/busy/update shape exactly, but lives in its own hook rather than
// nested inside the chat session: toggling overlay visibility isn't a chat
// concern, and unlike Skip TTS there's no frontend event to listen for -
// the OS-shortcut callback flips the backend state directly (see
// hotkeys.rs's register_overlay_shortcut), so this hook only needs to
// read/change which combo is registered.
export function useOverlayToggleHotkey() {
  const [status, setStatus] = useState<OverlayToggleHotkeyStatus | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    getOverlayToggleHotkeyStatus().then((next) => { if (active) setStatus(next); }).catch(() => { /* transient IPC hiccup */ });
    return () => { active = false; };
  }, []);

  const updateOverlayHotkey = useCallback(async (enabled: boolean, shortcut: string) => {
    setBusy(true);
    try {
      setStatus(await setOverlayToggleHotkey(enabled, shortcut));
    } catch (cause) {
      // A failed attempt never touches the previous working combo on the
      // Rust side (see hotkeys.rs's rollback) - refresh from there instead
      // of guessing at the resulting state ourselves.
      try { setStatus(await getOverlayToggleHotkeyStatus()); } catch { /* transient IPC hiccup */ }
      throw cause;
    } finally {
      setBusy(false);
    }
  }, []);

  return { status, busy, updateOverlayHotkey };
}
