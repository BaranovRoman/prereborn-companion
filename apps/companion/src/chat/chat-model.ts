import type { TwitchChatMessage } from "../services/dotaCompanionApi";
import { normalizeMessageForSpeech, parsePronunciationOverrides, resolveSpokenUsername } from "./tts-normalize";

export type TtsEngine = "system" | "piper";
export interface ChatSettings {
  soundEnabled: boolean;
  ttsEnabled: boolean;
  speakAuthor: boolean;
  maxLength: number;
  ttsEngine: TtsEngine;
  // Raw "username=spoken name" lines, one override per line - see
  // tts-normalize.ts's parsePronunciationOverrides. Deliberately a plain
  // string, not a structured list/editor.
  usernamePronunciations: string;
}
export const DEFAULT_CHAT_SETTINGS: ChatSettings = {
  soundEnabled: false,
  ttsEnabled: false,
  speakAuthor: true,
  maxLength: 180,
  ttsEngine: "system",
  usernamePronunciations: "",
};
export const nextUnreadCount = (current: number, isAtBottom: boolean, added: number) =>
  isAtBottom ? 0 : current + added;

const URL_PATTERN = /https?:\/\/\S+|www\.\S+/gi;
const REPEATED_PATTERN = /(.)\1{7,}/iu;
const ALLOWED_TYPES = new Set(["text", "channel_points_highlighted", "user_intro"]);

// Builds a speech-only representation of the message - never affects what's
// rendered in the chat UI (TwitchChatPage.tsx renders message.text/
// message.author straight from the original TwitchChatMessage, not this
// output). WK-66's safety filters (type allowlist, repeated-character spam
// drop) run first and unchanged, against the raw message text, so a message
// this function would otherwise mangle never reaches it in the first place.
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
  const speechText = normalizeMessageForSpeech(text);
  if (!speechText) return null;
  if (!settings.speakAuthor) return speechText;
  const overrides = parsePronunciationOverrides(settings.usernamePronunciations);
  const speechAuthor = resolveSpokenUsername(message.author, overrides);
  return `${speechAuthor}: ${speechText}`;
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

  // Returns the whole entry (not just `text`) so callers can correlate TTS
  // diagnostics trace events with the originating message id - see
  // TwitchChatPage.tsx's drainTts().
  takeNext(now = Date.now()): { id: string; text: string } | null {
    while (this.queue[0] && now - this.queue[0].receivedAt > this.maxAgeMs) this.queue.shift();
    const entry = this.queue.shift();
    return entry ? { id: entry.id, text: entry.text } : null;
  }

  clear() { this.queue.length = 0; }
  get size() { return this.queue.length; }
}
