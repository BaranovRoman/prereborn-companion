import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { emitTo, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getChatOverlayStatus } from "../core/api";
import type { TwitchChatMessage } from "../core/contracts";
import { buildEmoteMap, loadEmoteCatalog, readCachedCatalog, writeCachedCatalog } from "./emotes";
import {
  DEFAULT_OVERLAY_SETTINGS, OVERLAY_MODE_EVENT, OVERLAY_READY_EVENT, OVERLAY_STATE_EVENT,
  badgeRoles, readableNameColor, tokenizeMessage, visibleMessages,
  type EmoteRef, type OverlayState,
} from "./overlay-model";
import "./chat-overlay.css";

// WK-179 - root of the separate "chat-overlay" window (see main.tsx and
// src-tauri/src/chat_overlay.rs). It holds no Twitch connection of its own:
// the main window's chat session pushes OVERLAY_STATE_EVENT after every
// poll, and this window only renders it.

const BADGE_LABEL = { broadcaster: "Стример", moderator: "Модератор", vip: "VIP", subscriber: "Подписчик" } as const;

const broadcasterId = (messages: TwitchChatMessage[]) =>
  messages.find((message) => message.badges.some((badge) => badge.startsWith("broadcaster/")))?.authorId ?? null;

export function ChatOverlayApp() {
  const [state, setState] = useState<OverlayState>({ messages: [], settings: DEFAULT_OVERLAY_SETTINGS, channelLogin: null });
  const [clickThrough, setClickThrough] = useState(false);
  const [emotes, setEmotes] = useState<EmoteRef[]>([]);
  const [brokenEmotes, setBrokenEmotes] = useState<ReadonlySet<string>>(new Set());
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const unlisteners = [
      listen<OverlayState>(OVERLAY_STATE_EVENT, (event) => setState(event.payload)),
      listen<boolean>(OVERLAY_MODE_EVENT, (event) => setClickThrough(event.payload)),
    ];
    void Promise.all(unlisteners).then(() => emitTo("main", OVERLAY_READY_EVENT));
    void getChatOverlayStatus().then((status) => setClickThrough(status.clickThrough)).catch(() => undefined);
    return () => { unlisteners.forEach((pending) => void pending.then((unlisten) => unlisten())); };
  }, []);

  const fallbackId = broadcasterId(state.messages);
  const catalogKey = state.channelLogin ? state.channelLogin.toLowerCase() : fallbackId ? `id:${fallbackId}` : "";
  useEffect(() => {
    if (!state.settings.showEmotes) return;
    const cached = readCachedCatalog(catalogKey);
    if (cached) { setEmotes(cached); return; }
    let active = true;
    void loadEmoteCatalog(state.channelLogin, fallbackId).then((catalog) => {
      if (!active) return;
      setEmotes(catalog);
      writeCachedCatalog(catalogKey, catalog);
    });
    return () => { active = false; };
    // fallbackId is only a fallback; refetching whenever it flips would
    // hammer the providers, so the catalog follows the channel key alone.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [catalogKey, state.settings.showEmotes]);

  const emoteMap = useMemo(() => buildEmoteMap(emotes), [emotes]);
  const { settings } = state;
  const shown = visibleMessages(state.messages, settings);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [shown.length, shown[shown.length - 1]?.id]);

  const style = {
    "--overlay-font-size": `${settings.fontSize}px`,
    "--overlay-bg-alpha": String(settings.backgroundOpacity / 100),
  } as CSSProperties;
  const startResize = () => void getCurrentWindow().startResizeDragging("SouthEast");

  return <main className={`chat-overlay chat-overlay--${settings.style} ${clickThrough ? "" : "is-editing"}`} style={style}>
    {!clickThrough && <header className="chat-overlay__handle" data-tauri-drag-region>
      Twitch-чат · перетащите окно, тяните угол для размера
    </header>}
    <div className="chat-overlay__list" ref={listRef}>
      {!shown.length && !clickThrough && <p className="chat-overlay__empty">Новые сообщения Twitch появятся здесь.</p>}
      {shown.map((message) => {
        const roles = badgeRoles(message.badges);
        const parts = settings.showEmotes ? tokenizeMessage(message, emoteMap) : [{ kind: "text" as const, text: message.text }];
        return <p className={`chat-overlay__line ${roles.map((role) => `is-${role}`).join(" ")}`} key={message.id}>
          {settings.style === "wow" && <span className="chat-overlay__channel">[Twitch]</span>}
          {settings.showBadges && roles.map((role) =>
            <span className={`chat-overlay__badge chat-overlay__badge--${role}`} key={role} title={BADGE_LABEL[role]}>{BADGE_LABEL[role][0]}</span>)}
          <span className="chat-overlay__author" style={{ color: readableNameColor(message.color, message.author) }}>
            {settings.style === "wow" ? `[${message.author}]` : message.author}
          </span>
          <span className="chat-overlay__separator">: </span>
          <span className="chat-overlay__text">{parts.map((part, index) => part.kind === "text" || brokenEmotes.has(part.emote.url)
            ? <span key={index}>{part.kind === "text" ? part.text : part.emote.code}</span>
            : <img key={index} className="chat-overlay__emote" src={part.emote.url} alt={part.emote.code} title={part.emote.code}
              onError={() => setBrokenEmotes((current) => new Set(current).add(part.emote.url))} />)}
          </span>
        </p>;
      })}
    </div>
    {!clickThrough && <button type="button" className="chat-overlay__grip" aria-label="Изменить размер" onMouseDown={startResize} />}
  </main>;
}
