import { describe, expect, it } from "vitest";
import { BoundedTtsQueue, DEFAULT_CHAT_SETTINGS, nextUnreadCount, prepareTtsText } from "./chat-model";
import type { TwitchChatMessage } from "../services/dotaCompanionApi";

const message = (id: string, text = "hello", messageType = "text"): TwitchChatMessage => ({
  id, text, messageType, author: "Viewer", color: null, badges: [], receivedAt: "2026-08-12T00:00:00Z",
});
const enabled = { ...DEFAULT_CHAT_SETTINGS, ttsEnabled: true };

describe("chat model", () => {
  it("tracks unread only while history is being read", () => {
    expect(nextUnreadCount(2, false, 3)).toBe(5);
    expect(nextUnreadCount(2, true, 3)).toBe(0);
  });
  it("keeps TTS disabled by default", () => {
    const queue = new BoundedTtsQueue();
    expect(queue.enqueue(message("1"), DEFAULT_CHAT_SETTINGS)).toBe(false);
    expect(queue.size).toBe(0);
  });
  it("filters system, URL-only and repeated-character spam", () => {
    expect(prepareTtsText(message("1", "https://example.com"), enabled)).toBeNull();
    expect(prepareTtsText(message("2", "aaaaaaaaaaaa"), enabled)).toBeNull();
    expect(prepareTtsText(message("3", "notice", "system"), enabled)).toBeNull();
    expect(prepareTtsText(message("4", "see https://example.com now"), enabled)).toBe("Viewer: see ссылка now");
  });
  it("limits length and optionally omits author", () => {
    expect(prepareTtsText(message("1", "abcdefghij"), { ...enabled, speakAuthor: false, maxLength: 6 })).toBe("abcde…");
  });
  it("normalizes the username and message for speech without touching the displayed message", () => {
    const raw = message("5", "хахахахахаха го дальше 🔥", "text");
    raw.author = "Roma_Romych_TV";
    expect(prepareTtsText(raw, enabled)).toBe("Roma Romych: ха-ха го дальше");
    // The chat UI renders message.text/message.author directly - normalization
    // must never mutate the original message object.
    expect(raw.text).toBe("хахахахахаха го дальше 🔥");
    expect(raw.author).toBe("Roma_Romych_TV");
  });
  it("deduplicates, bounds and expires the queue", () => {
    const queue = new BoundedTtsQueue(2, 100);
    expect(queue.enqueue(message("1"), enabled, 0)).toBe(true);
    expect(queue.enqueue(message("1"), enabled, 0)).toBe(false);
    queue.enqueue(message("2"), enabled, 0);
    queue.enqueue(message("3"), enabled, 0);
    expect(queue.size).toBe(2);
    expect(queue.takeNext(101)).toBeNull();
  });
});
