import { useCallback, useEffect, useRef, useState } from "react";
import { emitTo, listen } from "@tauri-apps/api/event";
import {
  closeChatOverlay, getChatOverlayStatus, getTwitchIntegrationStatus, openChatOverlay, setChatOverlayClickThrough,
  type ChatOverlayStatus, type TwitchChatStatus,
} from "../core/api";
import {
  OVERLAY_LABEL, OVERLAY_READY_EVENT, OVERLAY_STATE_EVENT, loadOverlaySettings, saveOverlaySettings,
  type OverlaySettings, type OverlayState,
} from "./overlay-model";

export interface ChatOverlayControl {
  status: ChatOverlayStatus;
  settings: OverlaySettings;
  error: string | null;
  busy: boolean;
  updateSetting: <K extends keyof OverlaySettings>(key: K, value: OverlaySettings[K]) => void;
  setOpen: (open: boolean) => void;
  setClickThrough: (enabled: boolean) => void;
}

// WK-179 - main-window side of the chat overlay. Reuses the one chat session
// (useTwitchChatSession's 1.5s poll) and forwards its message list to the
// overlay window, so the overlay never opens a second Twitch/backend feed.
export function useChatOverlay(chat: TwitchChatStatus | null): ChatOverlayControl {
  const [status, setStatus] = useState<ChatOverlayStatus>({ open: false, clickThrough: false });
  const [settings, setSettings] = useState(loadOverlaySettings);
  const [channelLogin, setChannelLogin] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const latest = useRef<OverlayState>({ messages: [], settings, channelLogin });
  latest.current = { messages: chat?.messages ?? [], settings, channelLogin };

  const push = useCallback(() => { void emitTo(OVERLAY_LABEL, OVERLAY_STATE_EVENT, latest.current).catch(() => undefined); }, []);

  useEffect(() => { void getChatOverlayStatus().then(setStatus).catch(() => undefined); }, []);
  useEffect(() => {
    if (!chat?.accountConnected) return;
    void getTwitchIntegrationStatus().then((twitch) => setChannelLogin(twitch.login ?? null)).catch(() => undefined);
  }, [chat?.accountConnected]);
  useEffect(() => {
    const pending = listen(OVERLAY_READY_EVENT, push);
    return () => { void pending.then((unlisten) => unlisten()); };
  }, [push]);
  useEffect(() => { saveOverlaySettings(settings); }, [settings]);
  useEffect(() => { if (status.open) push(); }, [status.open, chat?.messages, settings, channelLogin, push]);

  const run = useCallback((work: () => Promise<ChatOverlayStatus>) => {
    setBusy(true);
    void work().then((next) => { setStatus(next); setError(null); })
      .catch((cause) => setError(String(cause)))
      .finally(() => setBusy(false));
  }, []);

  return {
    status, settings, error, busy,
    updateSetting: useCallback((key, value) => setSettings((current) => ({ ...current, [key]: value })), []),
    setOpen: useCallback((open: boolean) => run(open ? openChatOverlay : closeChatOverlay), [run]),
    setClickThrough: useCallback((enabled: boolean) => run(() => setChatOverlayClickThrough(enabled)), [run]),
  };
}
