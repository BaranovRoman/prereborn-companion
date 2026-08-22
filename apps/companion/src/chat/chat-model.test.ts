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
  // WK-81: Silero is the primary engine now (system speechSynthesis is the
  // only fallback since WK-80 removed Piper - see useTwitchChatSession.ts). WK-82 TTS
  // follow-up: xenia confirmed as default by a human blind-listening test
  // across all 63 available voice/model combinations (baya rated second,
  // still fully selectable - see silero.rs's SileroVoice::default comment).
  it("defaults to the Silero engine with the xenia voice", () => {
    expect(DEFAULT_CHAT_SETTINGS.ttsEngine).toBe("silero");
    expect(DEFAULT_CHAT_SETTINGS.sileroVoice).toBe("xenia");
  });
  it("filters system, URL-only and repeated-character spam", () => {
    expect(prepareTtsText(message("1", "https://example.com"), enabled)).toBeNull();
    expect(prepareTtsText(message("2", "aaaaaaaaaaaa"), enabled)).toBeNull();
    expect(prepareTtsText(message("3", "notice", "system"), enabled)).toBeNull();
    // WK-82: "see"/"now" are ordinary Latin words in the message body, now
    // transliterated the same way a Latin username fragment already was -
    // Silero's character whitelist deletes raw Latin outright (see
    // tts-normalize.ts's normalizeMessageForSpeech comment), so leaving
    // them as literal English would mean Silero never speaks them at all.
    expect(prepareTtsText(message("4", "see https://example.com now"), enabled)).toBe("Виевер: сее ссылка нов");
  });
  it("limits length and optionally omits author", () => {
    expect(prepareTtsText(message("1", "abcdefghij"), { ...enabled, speakAuthor: false, maxLength: 6 })).toBe("абкде…");
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

  // WK-82: pipeline-level regression - proves the exact final string handed
  // to speakWithSilero (useTwitchChatSession.ts) survives
  // Silero's character-whitelist deletion, not just that the isolated
  // tts-normalize.ts helper does. Goes through prepareTtsText end to end
  // (author resolution + speechText assembly), the same call site
  // useTwitchChatSession.ts uses.
  it("produces a final speech string with no digits/Latin lost to Silero's character whitelist", () => {
    const raw = message("1", "RTX 5060 Ti норм, WK-81 готов, порт 4455");
    raw.author = "Wisp";
    expect(prepareTtsText(raw, enabled)).toBe(
      "Висп: ар-ти-икс пять тысяч шестьдесят Ти норм, дабл-ю-кей восемьдесят один готов, порт четыре тысячи четыреста пятьдесят пять",
    );
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

  // WK-82 pre-merge audit: messages that are entirely Latin/digits, no
  // Cyrillic anchor at all - the worst case for silently going empty, since
  // there's no leftover Cyrillic content to fall back on. All six used to
  // reach Silero as "" (HTTP 500/RTX5060/WK-81/12345/GG/2k all hit the
  // character-whitelist deletion described on normalizeMessageForSpeech)
  // and throw inside apply_tts, dropping the whole utterance. None of them
  // may ever produce a null/empty prepareTtsText result through the full
  // pipeline (message-type/spam filters -> truncation -> normalization ->
  // author prefix), not just through the isolated normalizeMessageForSpeech
  // helper (see tts-normalize.test.ts for that half).
  it.each([
    ["HTTP 500"], ["RTX5060"], ["WK-81"], ["12345"], ["GG"], ["2k"],
  ] as const)("prepareTtsText never nulls out or empties a Latin/digit-only message: %s", ([text]) => {
    const result = prepareTtsText(message("1", text), { ...enabled, speakAuthor: false });
    expect(result).not.toBeNull();
    expect(result).not.toBe("");
    expect(result?.length).toBeGreaterThan(0);
  });

  // WK-82 pre-merge audit: maxLength truncates settings.maxLength characters
  // of the *raw* message text, BEFORE normalizeMessageForSpeech runs (see
  // buildSpeechParts above - truncation happens at the `text.slice(...)`
  // step, and speechText is computed from that already-truncated string).
  // This ordering is unchanged by WK-82 - only normalizeMessageForSpeech's
  // internals changed, not where/how buildSpeechParts calls it. What IS new
  // is that normalizeMessageForSpeech can now *expand* text (an acronym
  // becomes several spelled-out letter names, a number becomes several
  // words) where it previously only ever shrank or preserved length -  so
  // "final spoken text length <= maxLength" was never a real guarantee to
  // begin with for Latin content, it was just incidentally true before this
  // fix because the old normalizeMessageForSpeech was a no-op on Latin/
  // digits. maxLength still does exactly what it always did: bound how much
  // of the *raw* message gets read at all, protecting against pathological
  // raw input (e.g. a giant paste) - it was never a bound on synthesized
  // audio duration, and this PR doesn't change that contract or introduce a
  // new one. Extreme all-digit spam is still caught upstream by
  // REPEATED_PATTERN (8+ repeats of the same character) before maxLength or
  // normalization ever run.
  it("truncates the raw message before normalization, so expansion from acronym/number spelling is not double-counted against maxLength", () => {
    // Raw text is short (13 chars, well under maxLength=180) but expands
    // significantly once normalized - truncation must not kick in at all
    // here, since it's measured against the raw length, not the eventual
    // spoken length.
    const raw = "WK-81 RTX 5060";
    expect(raw.length).toBeLessThan(enabled.maxLength);
    const result = prepareTtsText(message("1", raw), { ...enabled, speakAuthor: false });
    expect(result).toBe("дабл-ю-кей восемьдесят один ар-ти-икс пять тысяч шестьдесят");
    expect(result!.length).toBeGreaterThan(raw.length); // expansion happened, and that's expected/fine

    // A tight maxLength still truncates the *raw* text exactly as before -
    // the cut lands mid-token ("WK-81 RTX 50" cut from "WK-81 RTX 5060"),
    // and normalization then reads whatever raw fragment survived
    // (including a differently-truncated number) rather than the original
    // untruncated token - a pre-existing, non-regressive property of
    // character-count truncation applied before any semantic step, not
    // something WK-82 introduced.
    const tight = prepareTtsText(message("2", raw), { ...enabled, speakAuthor: false, maxLength: 13 });
    expect(tight).toBe("дабл-ю-кей восемьдесят один ар-ти-икс пятьдесят…");
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
    // WK-82: "hi there" is ordinary Latin text in the message body - see
    // the comment on the "see .../now" case above for why it's now
    // transliterated rather than left raw.
    expect(queue.takeNext(0)).toEqual({ id: "1", text: "Виевер: хи тхере" });
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

    // WK-83: Skip is a playback-layer concern (useTwitchChatSession.ts) that
    // never calls back into the queue - a skipped message was still taken
    // via takeNext() (and so already marked "processed" for consecutive-
    // author purposes) exactly like a message that played to completion.
    // This locks in that a message being skipped, rather than fully spoken,
    // must not change whether the next same-author message announces the
    // name - the two paths are indistinguishable from the queue's view.
    it("a skipped message (still taken via takeNext, just never fully played) suppresses the name on the next same-author message exactly like a fully-played one would", () => {
      const queue = new BoundedTtsQueue(10);
      queue.enqueue(from("1", "это пропустят", "u1", "Roma"), enabled, 0);
      queue.enqueue(from("2", "тоже от ромы", "u1", "Roma"), enabled, 0);
      const taken = queue.takeNext(0);
      expect(taken?.text).toBe("Рома: это пропустят");
      // Simulate skipping "1" here: no queue method exists for this, on
      // purpose - skipTts() never touches BoundedTtsQueue at all.
      expect(queue.takeNext(0)?.text).toBe("тоже от ромы"); // name still suppressed
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
