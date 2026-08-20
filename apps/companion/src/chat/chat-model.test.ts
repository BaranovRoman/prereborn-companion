import { describe, expect, it } from "vitest";
import { BoundedTtsQueue, DEFAULT_CHAT_SETTINGS, nextUnreadCount, prepareTtsText } from "./chat-model";
import type { TwitchChatMessage } from "../services/dotaCompanionApi";

const message = (id: string, text = "hello", messageType = "text"): TwitchChatMessage => ({
  id, text, messageType, author: "Viewer", authorId: null, authorLogin: null, color: null, badges: [],
  receivedAt: "2026-08-12T00:00:00Z",
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
    expect(prepareTtsText(message("4", "see https://example.com now"), enabled)).toBe("Виевер: see ссылка now");
  });
  it("limits length and optionally omits author", () => {
    expect(prepareTtsText(message("1", "abcdefghij"), { ...enabled, speakAuthor: false, maxLength: 6 })).toBe("abcde…");
  });
  it("normalizes the username and message for speech without touching the displayed message", () => {
    const raw = message("5", "хахахахахаха го дальше 🔥", "text");
    raw.author = "Roma_Romych_TV";
    expect(prepareTtsText(raw, enabled)).toBe("Рома Ромыч: ха-ха го дальше");
    // The chat UI renders message.text/message.author directly - normalization
    // must never mutate the original message object.
    expect(raw.text).toBe("хахахахахаха го дальше 🔥");
    expect(raw.author).toBe("Roma_Romych_TV");
  });
  it("uses a pronunciation override when the settings define one for this username", () => {
    const withOverride = { ...enabled, usernamePronunciations: "romaromych=Ромчик" };
    expect(prepareTtsText(message("6", "го", "text"), { ...withOverride, speakAuthor: true, }))
      .toBe("Виевер: го"); // no override for "Viewer" - falls back to transliteration as usual
    const raw = message("7", "го", "text");
    raw.author = "RomaRomych";
    expect(prepareTtsText(raw, withOverride)).toBe("Ромчик: го");
  });
  // Regression for the reported truncation bug ("только произносится первый
  // вопрос"): the message is well under the default maxLength (180) and has
  // no run of 2+ consecutive punctuation marks, so neither the length cutoff
  // nor EXCESSIVE_PUNCTUATION should shorten it - proves the app's own text
  // pipeline passes the full multi-question message through untouched.
  it("does not truncate a multi-question message that fits within maxLength", () => {
    const raw = "а тебе снилось что ты бабочка? или бабочке снилось что это ты? или бабочке снилось что ты бабочка?";
    const result = prepareTtsText(message("1", raw), enabled);
    expect(result).toBe(`Виевер: ${raw}`);
    expect(result?.endsWith("бабочка?")).toBe(true);
  });

  it("truncation only kicks in at the character limit, never at sentence punctuation", () => {
    const raw = "первое предложение. второе предложение. третье предложение.";
    expect(prepareTtsText(message("1", raw), { ...enabled, speakAuthor: false, maxLength: 300 })).toBe(raw);
    // A tighter limit does cut it - by length, ending in an ellipsis, not at
    // the first ".".
    const truncated = prepareTtsText(message("2", raw), { ...enabled, speakAuthor: false, maxLength: 20 });
    expect(truncated).toHaveLength(20);
    expect(truncated?.endsWith("…")).toBe(true);
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
  it("takeNext returns the message id alongside the text for trace correlation", () => {
    const queue = new BoundedTtsQueue();
    queue.enqueue(message("1", "hi there"), enabled, 0);
    expect(queue.takeNext(0)).toEqual({ id: "1", text: "Виевер: hi there" });
    expect(queue.takeNext(0)).toBeNull();
  });

  describe("consecutive-author name suppression", () => {
    const from = (id: string, text: string, authorId: string, author = "Roma"): TwitchChatMessage => ({
      id, text, messageType: "text", author, authorId, authorLogin: null, color: null, badges: [],
      receivedAt: "2026-08-12T00:00:00Z",
    });

    it("speaks the name only before the first of several consecutive messages from the same author", () => {
      const queue = new BoundedTtsQueue(10);
      queue.enqueue(from("1", "первое", "u1"), enabled, 0);
      queue.enqueue(from("2", "второе", "u1"), enabled, 0);
      queue.enqueue(from("3", "третье", "u1"), enabled, 0);
      expect(queue.takeNext(0)?.text).toBe("Рома: первое");
      expect(queue.takeNext(0)?.text).toBe("второе");
      expect(queue.takeNext(0)?.text).toBe("третье");
    });

    it("re-announces the name once a different author speaks, and again when the original author returns", () => {
      const queue = new BoundedTtsQueue(10);
      queue.enqueue(from("1", "первое", "u1", "Roma"), enabled, 0);
      queue.enqueue(from("2", "второе", "u1", "Roma"), enabled, 0);
      queue.enqueue(from("3", "привет", "u2", "Wisp"), enabled, 0);
      queue.enqueue(from("4", "снова", "u1", "Roma"), enabled, 0);
      expect(queue.takeNext(0)?.text).toBe("Рома: первое");
      expect(queue.takeNext(0)?.text).toBe("второе");
      expect(queue.takeNext(0)?.text).toBe("Висп: привет"); // transliteration heuristic, not the point of this test
      expect(queue.takeNext(0)?.text).toBe("Рома: снова");
    });

    it("keys consecutiveness on the stable Twitch user id, not the display name", () => {
      // Same authorId, display name changes mid-run (e.g. a live rename) -
      // still treated as the same speaker, name suppressed on the second.
      const queue = new BoundedTtsQueue(10);
      queue.enqueue(from("1", "первое", "u1", "OldName"), enabled, 0);
      queue.enqueue(from("2", "второе", "u1", "NewName"), enabled, 0);
      expect(queue.takeNext(0)?.text).toBe("Олднаме: первое");
      expect(queue.takeNext(0)?.text).toBe("второе");
    });

    it("falls back to the display name as the identity key when no authorId is present", () => {
      const noId = (id: string, text: string, author: string): TwitchChatMessage => ({
        id, text, messageType: "text", author, authorId: null, authorLogin: null, color: null, badges: [],
        receivedAt: "2026-08-12T00:00:00Z",
      });
      const queue = new BoundedTtsQueue(10);
      queue.enqueue(noId("1", "первое", "Roma"), enabled, 0);
      queue.enqueue(noId("2", "второе", "roma"), enabled, 0); // same person, different casing
      expect(queue.takeNext(0)?.text).toBe("Рома: первое");
      expect(queue.takeNext(0)?.text).toBe("второе");
    });

    it("a message dropped by bounded-size overflow before being spoken does not suppress the name on what comes next", () => {
      // limit=1: enqueueing "2" evicts "1" (an unrelated author) before "1"
      // is ever taken - "1" must never be able to influence lastSpokenAuthor
      // for a still-unspoken queue.
      const queue = new BoundedTtsQueue(1);
      queue.enqueue(from("1", "никогда не прозвучит", "unrelated"), enabled, 0);
      queue.enqueue(from("2", "первое от ромы", "u1", "Roma"), enabled, 0);
      expect(queue.size).toBe(1); // "1" was evicted by the overflow policy
      expect(queue.takeNext(0)?.text).toBe("Рома: первое от ромы");
    });

    it("a message dropped by maxAgeMs staleness expiry before being taken does not suppress the name on what comes next", () => {
      const queue = new BoundedTtsQueue(10, 100);
      queue.enqueue(from("1", "устареет", "u1", "Roma"), enabled, 0);
      // Never taken before it goes stale - a later takeNext() call (for a
      // second, fresh message from the same author) must still speak the
      // name, proving the stale entry's eviction never touched
      // lastSpokenAuthorKey.
      queue.enqueue(from("2", "новое", "u1", "Roma"), enabled, 500);
      expect(queue.takeNext(500)?.text).toBe("Рома: новое");
    });

    it("resets on clear() (TTS stop/disable), so the next speaker's name is announced again", () => {
      const queue = new BoundedTtsQueue(10);
      queue.enqueue(from("1", "первое", "u1", "Roma"), enabled, 0);
      expect(queue.takeNext(0)?.text).toBe("Рома: первое");
      queue.clear();
      queue.enqueue(from("2", "снова", "u1", "Roma"), enabled, 0);
      expect(queue.takeNext(0)?.text).toBe("Рома: снова");
    });

    it("never prefixes a name at all when speakAuthor is off, regardless of author", () => {
      const off = { ...enabled, speakAuthor: false };
      const queue = new BoundedTtsQueue(10);
      queue.enqueue(from("1", "первое", "u1", "Roma"), off, 0);
      queue.enqueue(from("2", "привет", "u2", "Wisp"), off, 0);
      expect(queue.takeNext(0)?.text).toBe("первое");
      expect(queue.takeNext(0)?.text).toBe("привет");
    });
  });
});
