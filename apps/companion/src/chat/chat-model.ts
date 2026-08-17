import type { TwitchChatMessage } from "../services/dotaCompanionApi";

export type TtsEngine = "system" | "piper";
export interface ChatSettings {
  soundEnabled: boolean;
  ttsEnabled: boolean;
  speakAuthor: boolean;
  maxLength: number;
  ttsEngine: TtsEngine;
}
export const DEFAULT_CHAT_SETTINGS: ChatSettings = {
  soundEnabled: false,
  ttsEnabled: false,
  speakAuthor: true,
  maxLength: 180,
  ttsEngine: "system",
};
export const nextUnreadCount = (current: number, isAtBottom: boolean, added: number) =>
  isAtBottom ? 0 : current + added;

const URL_PATTERN = /https?:\/\/\S+|www\.\S+/gi;
const REPEATED_PATTERN = /(.)\1{7,}/iu;
const ALLOWED_TYPES = new Set(["text", "channel_points_highlighted", "user_intro"]);

export const prepareTtsText = (
  message: TwitchChatMessage,
  settings: ChatSettings,
): string | null => {
  if (!ALLOWED_TYPES.has(message.messageType) || REPEATED_PATTERN.test(message.text)) return null;
  let text = message.text.replace(URL_PATTERN, " ссылка ").replace(/\s+/g, " ").trim();
  if (!text || text === "ссылка") return null;
  if (text.length > settings.maxLength) {
    text = `${text.slice(0, Math.max(1, settings.maxLength - 1)).trimEnd()}…`;
  }
  return settings.speakAuthor ? `${message.author}: ${text}` : text;
};

interface QueueEntry { id: string; text: string; receivedAt: number }

export class BoundedTtsQueue {
  private readonly queue: QueueEntry[] = [];
  private readonly seen = new Set<string>();
  constructor(private readonly limit = 3, private readonly maxAgeMs = 15_000) {}

  enqueue(message: TwitchChatMessage, settings: ChatSettings, now = Date.now()) {
    if (!settings.ttsEnabled || this.seen.has(message.id)) return false;
    this.seen.add(message.id);
    while (this.seen.size > 160) {
      const id = this.seen.values().next().value;
      if (id) this.seen.delete(id);
    }
    const text = prepareTtsText(message, settings);
    if (!text) return false;
    if (this.queue.length >= this.limit) this.queue.shift();
    this.queue.push({ id: message.id, text, receivedAt: now });
    return true;
  }

  takeNext(now = Date.now()) {
    while (this.queue[0] && now - this.queue[0].receivedAt > this.maxAgeMs) this.queue.shift();
    return this.queue.shift()?.text ?? null;
  }

  clear() { this.queue.length = 0; }
  get size() { return this.queue.length; }
}
