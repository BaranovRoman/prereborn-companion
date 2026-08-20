import { describe, expect, it } from "vitest";
import {
  normalizeMessageForSpeech,
  normalizeUsernameForSpeech,
  parsePronunciationOverrides,
  resolveSpokenUsername,
} from "./tts-normalize";

describe("normalizeUsernameForSpeech", () => {
  it("leaves an ordinary Russian username as-is", () => {
    expect(normalizeUsernameForSpeech("Роман")).toBe("Роман");
  });

  it("transliterates an ordinary Latin username to a Cyrillic phonetic form", () => {
    expect(normalizeUsernameForSpeech("Alex")).toBe("Алекс");
  });

  // The two motivating examples from the WK-77 follow-up: Piper's ru_RU
  // voice (via espeak-ng) mangles raw Latin text - "romaromych" came out
  // sounding like "омаомыч" (dropped leading r), "imwisp" like "имисп"
  // (dropped w entirely). Transliterating to Cyrillic first sidesteps that.
  it("transliterates romaromych to ромаромыч", () => {
    expect(normalizeUsernameForSpeech("romaromych")).toBe("ромаромыч");
  });

  it("transliterates imwisp to имвисп (w reads as a soft в, not dropped)", () => {
    expect(normalizeUsernameForSpeech("imwisp")).toBe("имвисп");
  });

  it("turns underscores into pauses between name parts", () => {
    expect(normalizeUsernameForSpeech("Roma_Romych")).toBe("Рома Ромыч");
  });

  it("separates letters from digits instead of reading them glued together", () => {
    expect(normalizeUsernameForSpeech("Player228")).toBe("Плаыер 228");
  });

  it("drops a long digit run (id-like suffix) but keeps a short one", () => {
    expect(normalizeUsernameForSpeech("xqc_48210394")).toBe("кскк");
    expect(normalizeUsernameForSpeech("Player7")).toBe("Плаыер 7");
  });

  it("strips a trailing TV/TTV suffix before transliterating", () => {
    expect(normalizeUsernameForSpeech("Roma_Romych_TV")).toBe("Рома Ромыч");
    expect(normalizeUsernameForSpeech("StreamerTTV")).not.toContain("TTV");
  });

  it("matches the example from the task: Roma_Romych_TV reads as a name, not a raw handle", () => {
    const spoken = normalizeUsernameForSpeech("Roma_Romych_TV");
    expect(spoken).toBe("Рома Ромыч");
  });

  it("collapses repeated characters within a token before transliterating", () => {
    expect(normalizeUsernameForSpeech("xXxAAAAAxXx")).toBe(normalizeUsernameForSpeech("xXxAAxXx"));
  });

  it("drops an unreadable consonant-only fragment but keeps a readable one", () => {
    expect(normalizeUsernameForSpeech("qzxkrpt_Roma")).toBe("Рома");
  });

  it("never goes silent - falls back to a transliterated original when everything is filtered out", () => {
    // "TTV" alone is stripped as a whole-token platform suffix, leaving no
    // tokens - the fallback must still not just re-emit the raw Latin.
    expect(normalizeUsernameForSpeech("TTV")).toBe("Ттв");
  });

  it("transliterates the Latin half of a mixed Cyrillic/Latin username, leaves the Cyrillic half alone", () => {
    expect(normalizeUsernameForSpeech("Иван-Max")).toBe("Иван Макс");
  });
});

describe("pronunciation overrides", () => {
  it("parses username=spoken name lines, case-insensitively on the username", () => {
    const overrides = parsePronunciationOverrides("romaromych=Ромаромыч\nAlex=Алехандро\n\nnot a line\n");
    expect(overrides).toEqual({ romaromych: "Ромаромыч", alex: "Алехандро" });
  });

  it("an explicit override wins over automatic transliteration", () => {
    const overrides = parsePronunciationOverrides("romaromych=Ромчик");
    expect(resolveSpokenUsername("romaromych", overrides)).toBe("Ромчик");
    expect(resolveSpokenUsername("RomaRomych", overrides)).toBe("Ромчик");
  });

  it("falls back to automatic transliteration for an unknown Latin username", () => {
    const overrides = parsePronunciationOverrides("romaromych=Ромчик");
    expect(resolveSpokenUsername("imwisp", overrides)).toBe("имвисп");
  });

  // Root-cause regression coverage (see chat-model.ts's SpeechParts comment
  // and the WK-XX writeup): the lookup key a streamer types is naturally
  // their viewer's Twitch *login* ("romaromych", from the channel URL), but
  // the value actually spoken as the author used to be matched only against
  // the *display name* (chatter_user_name) - which is a separate, cosmetic
  // field a viewer can set independently of their login. Whenever the two
  // differ, matching only on display name makes a correctly-configured
  // override silently never fire. resolveSpokenUsername's optional third
  // argument is the login; it must be tried first.
  it("uses ROMAROMYCH=ромаромыч, matched exactly as the motivating example", () => {
    const overrides = parsePronunciationOverrides("romaromych=ромаромыч");
    expect(resolveSpokenUsername("romaromych", overrides)).toBe("ромаромыч");
  });

  it("matches the username case-insensitively (ROMAROMYCH uppercase lookup)", () => {
    const overrides = parsePronunciationOverrides("romaromych=ромаромыч");
    expect(resolveSpokenUsername("ROMAROMYCH", overrides)).toBe("ромаромыч");
  });

  it("matches an override by Twitch login even when the display name differs entirely", () => {
    const overrides = parsePronunciationOverrides("romaromych=Ромаромыч");
    // Display name ("Somebody") doesn't match any override on its own -
    // only the login does. Without login-aware matching this would fall
    // through to automatic transliteration of "Somebody" instead.
    expect(resolveSpokenUsername("Somebody", overrides, "romaromych")).toBe("Ромаромыч");
  });

  it("still matches by display name when no login is available", () => {
    const overrides = parsePronunciationOverrides("romaromych=Ромаромыч");
    expect(resolveSpokenUsername("romaromych", overrides, null)).toBe("Ромаромыч");
    expect(resolveSpokenUsername("romaromych", overrides, undefined)).toBe("Ромаромыч");
  });

  it("tolerates spaces around the '=' separator and around both sides", () => {
    const overrides = parsePronunciationOverrides("  romaromych   =   ромаромыч  ");
    expect(overrides).toEqual({ romaromych: "ромаромыч" });
  });

  it("parses several mappings, one per line", () => {
    const overrides = parsePronunciationOverrides("romaromych=ромаромыч\nimwisp=имвисп\nAlex=Алехандро");
    expect(overrides).toEqual({ romaromych: "ромаромыч", imwisp: "имвисп", alex: "Алехандро" });
  });

  it("safely ignores malformed lines instead of throwing or producing a bad entry", () => {
    const overrides = parsePronunciationOverrides(
      "romaromych=ромаромыч\nno equals sign here\n=missing username\njustusername=\n\nimwisp=имвисп",
    );
    // Only the two well-formed lines survive: no "=", "=" at position 0
    // (empty username), and an empty spoken value are all dropped rather
    // than producing a garbage key/value.
    expect(overrides).toEqual({ romaromych: "ромаромыч", imwisp: "имвисп" });
  });

  it("survives a restart: the raw setting round-trips through JSON (localStorage) and still resolves", () => {
    // useTwitchChatSession persists ChatSettings.usernamePronunciations as
    // one field of a JSON.stringify'd object (localStorage) and re-parses it
    // with parsePronunciationOverrides on next load - exercise exactly that
    // round trip, including a Unicode spoken value, rather than trusting
    // JSON.stringify/parse to be lossless by assumption.
    const persisted = JSON.stringify({ usernamePronunciations: "romaromych=Ромаромыч\nimwisp=Имвисп" });
    const reloaded = JSON.parse(persisted) as { usernamePronunciations: string };
    const overrides = parsePronunciationOverrides(reloaded.usernamePronunciations);
    expect(resolveSpokenUsername("romaromych", overrides)).toBe("Ромаромыч");
    expect(resolveSpokenUsername("imwisp", overrides)).toBe("Имвисп");
  });
});

describe("normalizeMessageForSpeech", () => {
  it("leaves an ordinary message unchanged", () => {
    expect(normalizeMessageForSpeech("го на следующую катку")).toBe("го на следующую катку");
  });

  it("does not mangle a mixed Cyrillic/Latin message", () => {
    expect(normalizeMessageForSpeech("го play дальше ливай")).toBe("го play дальше ливай");
  });

  it("shortens long laughter", () => {
    expect(normalizeMessageForSpeech("хахахахахаха ну ты даёшь")).toBe("ха-ха ну ты даёшь");
    expect(normalizeMessageForSpeech("ахахах ахах ахах")).toBe("ха-ха");
  });

  it("does not touch gg/well-played shorthand (not laughter)", () => {
    expect(normalizeMessageForSpeech("гг вп")).toBe("гг вп");
  });

  it("removes emoji rather than speaking them", () => {
    expect(normalizeMessageForSpeech("красиво сыграно 🔥🔥🔥")).toBe("красиво сыграно");
    expect(normalizeMessageForSpeech("го 😂😂 в игру")).toBe("го в игру");
  });

  it("normalizes excessive punctuation", () => {
    expect(normalizeMessageForSpeech("что????")).toBe("что?");
    expect(normalizeMessageForSpeech("нет!!!")).toBe("нет!");
    expect(normalizeMessageForSpeech("серьёзно?!?!?!")).toBe("серьёзно?!");
  });

  it("collapses long repeated-character runs that are not spam-filtered", () => {
    expect(normalizeMessageForSpeech("топ комманднааааая игра")).toBe("топ комманднаая игра");
  });

  it("collapses whitespace after other normalization", () => {
    expect(normalizeMessageForSpeech("го   🔥  дальше")).toBe("го дальше");
  });

  // Regression for the reported truncation bug: this exact multi-question
  // message was only spoken up to the first "?". EXCESSIVE_PUNCTUATION only
  // matches RUNS of 2+ consecutive marks - these are three isolated single
  // "?"s separated by words, so nothing here should touch them. `.`/`!`/`?`
  // must never be treated as "stop after the first sentence".
  it("does not truncate a message with multiple isolated question marks", () => {
    const message =
      "а тебе снилось что ты бабочка? или бабочке снилось что это ты? или бабочке снилось что ты бабочка?";
    expect(normalizeMessageForSpeech(message)).toBe(message);
  });

  it("does not truncate at isolated periods or a mixed ?! across several clauses", () => {
    const periods = "первое предложение. второе предложение. третье предложение.";
    expect(normalizeMessageForSpeech(periods)).toBe(periods);
    const mixed = "серьёзно? ты уверен?! точно да!";
    expect(normalizeMessageForSpeech(mixed)).toBe(mixed);
  });
});
