import type { SileroVoice, TwitchChatMessage } from "../services/dotaCompanionApi";
import { normalizeMessageForSpeech, parsePronunciationOverrides, resolveSpokenUsername } from "./tts-normalize";

// WK-81 - Silero is the primary engine (see docs/research/wk-81-silero-tts-feasibility.md).
// WK-80 removed Piper: system speechSynthesis is now Silero's only
// fallback - the fallback chain itself lives in useTwitchChatSession.ts,
// not here. "system" isn't user-selectable from the settings UI, only
// reachable as the automatic fallback.
export type TtsEngine = "system" | "silero";
export interface ChatSettings {
  soundEnabled: boolean;
  ttsEnabled: boolean;
  speakAuthor: boolean;
  maxLength: number;
  ttsEngine: TtsEngine;
  // Only meaningful when ttsEngine === "silero" - which of the 5 named
  // Silero voices to use, both for real messages and the settings-page
  // preview button.
  sileroVoice: SileroVoice;
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
  ttsEngine: "silero",
  // Confirmed by a human blind-listening test across all 63 available
  // Silero voice/model combinations (WK-82 TTS follow-up) - "xenia"
  // (v5_5_ru) rated best, "baya" (also v5_5_ru) second and still fully
  // selectable. This is the value a user who has never picked a voice
  // gets; an existing saved choice in localStorage is never overwritten
  // (see loadSettings in useTwitchChatSession.ts).
  sileroVoice: "xenia",
  usernamePronunciations: "",
};
export const nextUnreadCount = (current: number, isAtBottom: boolean, added: number) =>
  isAtBottom ? 0 : current + added;

const URL_PATTERN = /https?:\/\/\S+|www\.\S+/gi;
const REPEATED_PATTERN = /(.)\1{7,}/iu;
const ALLOWED_TYPES = new Set(["text", "channel_points_highlighted", "user_intro"]);

interface SpeechParts {
  // Identity used to detect "same author as the previous spoken message"
  // (see BoundedTtsQueue below) - Twitch's stable chatter_user_id when
  // present, else the trimmed/lowercased display name. `null` only when
  // `speakAuthor` is off, i.e. no name is ever spoken so there's nothing to
  // track. Deliberately not derived from `authorLogin`: two viewers could in
  // principle share how their login reads case-insensitively only by
  // coincidence, whereas chatter_user_id is Twitch's own unique identity.
  authorKey: string | null;
  speechAuthor: string | null;
  speechText: string;
}

// Shared filtering/normalization core for both prepareTtsText (below - the
// simple "just give me the full spoken string" call site used by tests and
// anything that doesn't care about cross-message state) and
// BoundedTtsQueue.enqueue (which needs speechAuthor/speechText kept apart so
// takeNext() can decide whether to prefix the name *after* queue drops have
// already happened - see the class comment).
const buildSpeechParts = (message: TwitchChatMessage, settings: ChatSettings): SpeechParts | null => {
  if (!ALLOWED_TYPES.has(message.messageType) || REPEATED_PATTERN.test(message.text)) return null;
  let text = message.text.replace(URL_PATTERN, " ссылка ").replace(/\s+/g, " ").trim();
  if (!text || text === "ссылка") return null;
  if (text.length > settings.maxLength) {
    text = `${text.slice(0, Math.max(1, settings.maxLength - 1)).trimEnd()}…`;
  }
  const speechText = normalizeMessageForSpeech(text);
  if (!speechText) return null;
  if (!settings.speakAuthor) return { authorKey: null, speechAuthor: null, speechText };
  const overrides = parsePronunciationOverrides(settings.usernamePronunciations);
  const speechAuthor = resolveSpokenUsername(message.author, overrides, message.authorLogin);
  const authorKey = message.authorId?.trim() || message.author.trim().toLowerCase();
  return { authorKey, speechAuthor, speechText };
};

// Builds a speech-only representation of the message - never affects what's
// rendered in the chat UI (TwitchChatPage.tsx renders message.text/
// message.author straight from the original TwitchChatMessage, not this
// output). WK-66's safety filters (type allowlist, repeated-character spam
// drop) run first and unchanged, against the raw message text, so a message
// this function would otherwise mangle never reaches it in the first place.
// Always includes the author (when `speakAuthor` is on) - the
// consecutive-author name suppression only happens inside BoundedTtsQueue,
// which has the cross-message state this function intentionally doesn't.
export const prepareTtsText = (
  message: TwitchChatMessage,
  settings: ChatSettings,
): string | null => {
  const parts = buildSpeechParts(message, settings);
  if (!parts) return null;
  return parts.speechAuthor ? `${parts.speechAuthor}: ${parts.speechText}` : parts.speechText;
};

interface QueueEntry { id: string; authorKey: string | null; speechAuthor: string | null; speechText: string; receivedAt: number }

export class BoundedTtsQueue {
  private readonly queue: QueueEntry[] = [];
  private readonly seen = new Set<string>();
  // Author of the most recently *actually taken* (takeNext()'d) entry - not
  // the most recently enqueued one. Deliberately updated only inside
  // takeNext(), not enqueue(): a message can be enqueued and then dropped
  // before ever reaching synthesis (bounded-size overflow shift below, or
  // maxAgeMs staleness eviction in takeNext() itself) without ever being
  // spoken, and a dropped message must not suppress the name on whatever
  // does end up spoken next for that author. null means "nothing spoken
  // yet" (fresh queue, or since the last clear()) - the next name is always
  // announced.
  private lastSpokenAuthorKey: string | null = null;
  constructor(private readonly limit = 3, private readonly maxAgeMs = 15_000) {}

  enqueue(message: TwitchChatMessage, settings: ChatSettings, now = Date.now()) {
    if (!settings.ttsEnabled || this.seen.has(message.id)) return false;
    this.seen.add(message.id);
    while (this.seen.size > 160) {
      const id = this.seen.values().next().value;
      if (id) this.seen.delete(id);
    }
    const parts = buildSpeechParts(message, settings);
    if (!parts) return false;
    if (this.queue.length >= this.limit) this.queue.shift();
    this.queue.push({ id: message.id, ...parts, receivedAt: now });
    return true;
  }

  // Returns the whole entry (not just `text`) so callers can correlate TTS
  // diagnostics trace events with the originating message id - see
  // TwitchChatPage.tsx's drainTts(). This is also the single point where a
  // queued entry's author is compared against lastSpokenAuthorKey and the
  // name is prefixed only on a change - see the field comment above for why
  // that decision lives here (after drops) rather than in enqueue().
  takeNext(now = Date.now()): { id: string; text: string } | null {
    while (this.queue[0] && now - this.queue[0].receivedAt > this.maxAgeMs) this.queue.shift();
    const entry = this.queue.shift();
    if (!entry) return null;
    let text = entry.speechText;
    if (entry.speechAuthor !== null) {
      if (entry.authorKey !== this.lastSpokenAuthorKey) text = `${entry.speechAuthor}: ${entry.speechText}`;
      this.lastSpokenAuthorKey = entry.authorKey;
    }
    return { id: entry.id, text };
  }

  // Also resets the consecutive-author tracker - clear() is only ever called
  // when TTS is stopped/disabled (see useTwitchChatSession.ts) or a fresh
  // queue is constructed (app restart), both natural "start announcing names
  // again" points per spec, not mid-session churn.
  clear() { this.queue.length = 0; this.lastSpokenAuthorKey = null; }
  get size() { return this.queue.length; }
}
