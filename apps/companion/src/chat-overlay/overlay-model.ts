import type { TwitchChatMessage } from "../core/contracts";

// WK-179 - pure model of the Twitch chat overlay window (see
// src-tauri/src/chat_overlay.rs for why this is an overlay and not a WoW
// addon). Everything here is DOM/Tauri-free so it can be unit-tested.

export type OverlayStyle = "plain" | "wow";
export interface OverlaySettings {
  style: OverlayStyle;
  // Background opacity in percent; text always stays fully opaque.
  backgroundOpacity: number;
  fontSize: number;
  maxMessages: number;
  hideCommands: boolean;
  showBadges: boolean;
  showEmotes: boolean;
}
export const DEFAULT_OVERLAY_SETTINGS: OverlaySettings = {
  style: "wow",
  backgroundOpacity: 35,
  fontSize: 15,
  maxMessages: 20,
  hideCommands: true,
  showBadges: true,
  showEmotes: true,
};

export const OVERLAY_LABEL = "chat-overlay";
export const OVERLAY_STATE_EVENT = "chat-overlay://state";
export const OVERLAY_MODE_EVENT = "chat-overlay://mode";
export const OVERLAY_READY_EVENT = "chat-overlay://ready";
export interface OverlayState {
  messages: TwitchChatMessage[];
  settings: OverlaySettings;
  channelLogin: string | null;
}

const STORAGE_KEY = "companion-chat-overlay-settings-v1";
const clamp = (value: unknown, min: number, max: number, fallback: number) =>
  typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback;

export const normalizeOverlaySettings = (raw: unknown): OverlaySettings => {
  const value = (raw && typeof raw === "object" ? raw : {}) as Partial<Record<keyof OverlaySettings, unknown>>;
  const bool = (key: "hideCommands" | "showBadges" | "showEmotes") =>
    typeof value[key] === "boolean" ? value[key] as boolean : DEFAULT_OVERLAY_SETTINGS[key];
  return {
    style: value.style === "plain" || value.style === "wow" ? value.style : DEFAULT_OVERLAY_SETTINGS.style,
    backgroundOpacity: clamp(value.backgroundOpacity, 0, 100, DEFAULT_OVERLAY_SETTINGS.backgroundOpacity),
    fontSize: clamp(value.fontSize, 11, 32, DEFAULT_OVERLAY_SETTINGS.fontSize),
    maxMessages: clamp(value.maxMessages, 3, 50, DEFAULT_OVERLAY_SETTINGS.maxMessages),
    hideCommands: bool("hideCommands"),
    showBadges: bool("showBadges"),
    showEmotes: bool("showEmotes"),
  };
};
export const loadOverlaySettings = (): OverlaySettings => {
  try { return normalizeOverlaySettings(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}")); }
  catch { return DEFAULT_OVERLAY_SETTINGS; }
};
export const saveOverlaySettings = (settings: OverlaySettings) => {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(settings)); }
  catch { /* The in-memory settings stay applied if persistence is unavailable. */ }
};

// The backend already dedups by id and keeps receivedAt order (see
// merge_twitch_chat_status in backend/mod.rs), so the overlay only filters
// and trims - a reconnect replaying the same ids can't duplicate lines.
export const visibleMessages = (messages: TwitchChatMessage[], settings: OverlaySettings) => {
  const seen = new Set<string>();
  const kept = messages.filter((message) => {
    if (seen.has(message.id)) return false;
    seen.add(message.id);
    if (!message.text.trim()) return false;
    return !(settings.hideCommands && message.text.trimStart().startsWith("!"));
  });
  return kept.slice(-settings.maxMessages);
};

export type BadgeRole = "broadcaster" | "moderator" | "vip" | "subscriber";
const ROLE_ORDER: BadgeRole[] = ["broadcaster", "moderator", "vip", "subscriber"];
export const badgeRoles = (badges: string[]): BadgeRole[] => {
  const sets = new Set(badges.map((badge) => badge.split("/")[0]));
  return ROLE_ORDER.filter((role) => sets.has(role) || (role === "subscriber" && sets.has("founder")));
};

// Twitch lets chatters pick very dark name colors (#0000FF, #000000) that
// vanish on the overlay's dark background; lift those toward white instead of
// discarding the chosen hue.
const FALLBACK_COLORS = ["#ff7f50", "#9acd32", "#1e90ff", "#ff69b4", "#daa520", "#00ff7f", "#b886ff", "#5f9ea0"];
export const readableNameColor = (color: string | null, author: string) => {
  const match = /^#?([0-9a-f]{6})$/i.exec(color ?? "");
  if (!match) {
    let hash = 0;
    for (const char of author) hash = (hash * 31 + char.codePointAt(0)!) >>> 0;
    return FALLBACK_COLORS[hash % FALLBACK_COLORS.length];
  }
  const channels = [0, 2, 4].map((offset) => parseInt(match[1].slice(offset, offset + 2), 16));
  const luminance = (0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2]) / 255;
  if (luminance >= 0.35) return `#${match[1].toLowerCase()}`;
  const mix = 0.55;
  return `#${channels.map((value) => Math.round(value + (255 - value) * mix).toString(16).padStart(2, "0")).join("")}`;
};

export interface EmoteRef { code: string; url: string; source: "twitch" | "7tv" | "bttv" | "ffz" }
export type MessagePart = { kind: "text"; text: string } | { kind: "emote"; emote: EmoteRef };

const twitchEmoteUrl = (id: string) => `https://static-cdn.jtvnw.net/emoticons/v2/${encodeURIComponent(id)}/default/dark/1.0`;

// Splits a message into text and emote parts. Twitch-native emotes come only
// from EventSub fragments (optional on TwitchChatMessage until the API
// forwards them); third-party emotes match whole whitespace-separated words.
// Text between emotes, including the whitespace itself, is kept verbatim.
export const tokenizeMessage = (message: TwitchChatMessage, emotes: ReadonlyMap<string, EmoteRef>): MessagePart[] => {
  const fragments = message.fragments?.length ? message.fragments : [{ type: "text", text: message.text }];
  const parts: MessagePart[] = [];
  const pushText = (text: string) => {
    const last = parts[parts.length - 1];
    if (last?.kind === "text") last.text += text;
    else if (text) parts.push({ kind: "text", text });
  };
  for (const fragment of fragments) {
    if (fragment.type === "emote" && fragment.emote?.id) {
      parts.push({ kind: "emote", emote: { code: fragment.text, url: twitchEmoteUrl(fragment.emote.id), source: "twitch" } });
      continue;
    }
    for (const piece of fragment.text.split(/(\s+)/)) {
      const emote = piece && !/^\s+$/.test(piece) ? emotes.get(piece) : undefined;
      if (emote) parts.push({ kind: "emote", emote });
      else pushText(piece);
    }
  }
  return parts;
};
