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

  // WK-82: this test's original contract ("mixed Cyrillic/Latin message
  // survives byte-for-byte") turned out to protect the wrong thing.
  // Confirmed directly against the real shipped v5_5_ru model: Silero's own
  // prepare_text_input() runs a hard Cyrillic+punctuation+space character
  // whitelist and unconditionally *deletes* every digit and Latin letter
  // before synthesis - "leave it untouched" was actually leaving it to be
  // silently destroyed by the engine. The safety property worth protecting
  // was never "bit-identical text", it was "the TTS engine actually speaks
  // this content" - see the table-driven suite below for the replacement
  // contract, and normalizeMessageForSpeech's own comment for the full
  // root-cause writeup.
  it("transliterates an ordinary Latin word in a mixed message instead of leaving it for Silero to silently delete", () => {
    expect(normalizeMessageForSpeech("го play дальше ливай")).toBe("го плаы дальше ливай");
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

// WK-82: table-driven regression coverage for mixed Cyrillic/Latin/digit
// message bodies. Every case here is grounded in a real, directly-confirmed
// finding (not a guess): Silero's shipped v5_5_ru model runs a hard
// Cyrillic+punctuation+space character whitelist before synthesis and
// unconditionally deletes every digit and Latin letter it finds - "RTX 5060
// Ti норм" reaches the real engine as bare "норм", "HTTP 500" reaches it as
// "" (which throws and drops the whole utterance). See
// normalizeMessageForSpeech's own comment for the full writeup and the
// general rules (token classification, acronym-vs-word, number-to-words)
// this table exercises - none of these strings are individually
// special-cased in the implementation.
describe("normalizeMessageForSpeech - mixed-script/digit regression table (WK-82)", () => {
  const cases: [string, string][] = [
    // Bare version/ticket-style codes - acronym spelled out letter by
    // letter, number spelled out in full, hyphen dropped in favour of a
    // word boundary.
    ["WK-81 уже готов", "дабл-ю-кей восемьдесят один уже готов"],
    ["WK79", "дабл-ю-кей семьдесят девять"],
    // Spaced acronym + number + ordinary mixed-case word (Ti isn't
    // all-caps, so it's transliterated as a word, not spelled out).
    ["RTX 5060 Ti норм", "ар-ти-икс пять тысяч шестьдесят Ти норм"],
    ["RTX 5060", "ар-ти-икс пять тысяч шестьдесят"],
    // Underscore/dot-separated version-like token: single-letter prefix,
    // two digit groups, ordinary trailing word.
    ["v5_5_ru работает", "в пять пять ру работает"],
    // A username-shaped word inside the message body (not the author
    // field) - ordinary-word transliteration, same table as usernames.
    ["imwisp2 написал 2 сообщения", "имвисп два написал два сообщения"],
    // Acronym glued directly to a digit, no space.
    ["OBS2 подключён к порту 4455", "оу-би-эс два подключён к порту четыре тысячи четыреста пятьдесят пять"],
    // Acronym + number that would otherwise leave Silero literally nothing
    // to synthesize (confirmed: this exact pair throws inside apply_tts).
    ["HTTP 500", "эйч-ти-ти-пи пятьсот"],
    ["Windows 11", "Виндовс одиннадцать"],
    ["FPS 144", "эф-пи-эс сто сорок четыре"],
    ["OBS WebSocket 4455", "оу-би-эс Вебсоккет четыре тысячи четыреста пятьдесят пять"],
    // Digit+letter glued token, single lowercase letter kept as-is (not
    // expanded to "thousand" - no semantic slang expansion, by design).
    ["3D модель", "три ди модель"],
    ["2k рейтинга", "два к рейтинга"],
    // Digit-hyphen-digit score.
    ["GG 2-0", "джи-джи два ноль"],
    // Bare numbers in an otherwise plain Cyrillic sentence - these were
    // silently deleted by Silero before this fix, with no other symptom.
    ["порт 0", "порт ноль"],
    ["счёт 2-0 в нашу пользу", "счёт два ноль в нашу пользу"],
  ];

  it.each(cases)("%s -> %s", (input, expected) => {
    expect(normalizeMessageForSpeech(input)).toBe(expected);
  });

  it("never touches a Cyrillic-only message, even one with a hyphenated compound word", () => {
    expect(normalizeMessageForSpeech("какой-то результат")).toBe("какой-то результат");
    expect(normalizeMessageForSpeech("сегодня сыграл три игры подряд")).toBe("сегодня сыграл три игры подряд");
  });

  it("distinguishes an ordinary Latin word from a short all-caps acronym", () => {
    // Ordinary words (mixed/lower case) get whole-word phonetic
    // transliteration, same table as usernames - not spelled out letter by
    // letter.
    expect(normalizeMessageForSpeech("hello")).toBe("хелло");
    expect(normalizeMessageForSpeech("iPhone")).toBe("ипхоне");
    expect(normalizeMessageForSpeech("Windows")).toBe("Виндовс");
    // Short all-caps runs are spelled out letter by letter instead, since
    // blending them the same way produces an unpronounceable consonant
    // cluster (confirmed: Silero keeps "RTX" pre-transliterated to "РТХ"
    // as literal "ртх", not something resembling the acronym read aloud).
    expect(normalizeMessageForSpeech("RTX")).toBe("ар-ти-икс");
    expect(normalizeMessageForSpeech("OBS")).toBe("оу-би-эс");
    expect(normalizeMessageForSpeech("HTTP")).toBe("эйч-ти-ти-пи");
    expect(normalizeMessageForSpeech("USB")).toBe("ю-эс-би");
  });

  it("keeps a trailing punctuation mark attached to a number token", () => {
    expect(normalizeMessageForSpeech("порт 4455?")).toBe("порт четыре тысячи четыреста пятьдесят пять?");
  });

  it("spells out a large digit run rather than dropping it, without needing a special case", () => {
    expect(normalizeMessageForSpeech("id 48210394 забанен")).toBe(
      "ид сорок восемь миллионов двести десять тысяч триста девяносто четыре забанен",
    );
  });
});

// Pre-merge audit (reviewer request on WK-82): messages that are *entirely*
// Latin/digits, with no Cyrillic anchor at all, are the worst case for the
// "does this ever go silently empty" risk - a pure-Cyrillic or mostly-
// Cyrillic message always has surviving Cyrillic content regardless of what
// this function does to the Latin/digit part, but a Latin/digit-only
// message has nothing else to fall back on. Every one of these used to
// reach Silero as "" and throw (see the root-cause comment on
// normalizeMessageForSpeech) - none of them may ever normalize to "".
describe("normalizeMessageForSpeech - never produces an empty result for a Latin/digit-only message (WK-82 audit)", () => {
  const standaloneCases: [string, string][] = [
    ["HTTP 500", "эйч-ти-ти-пи пятьсот"],
    ["RTX5060", "ар-ти-икс пять тысяч шестьдесят"],
    ["WK-81", "дабл-ю-кей восемьдесят один"],
    ["12345", "двенадцать тысяч триста сорок пять"],
    ["GG", "джи-джи"],
    ["2k", "два к"],
  ];

  it.each(standaloneCases)("%s -> %s, and is never empty", (input, expected) => {
    const result = normalizeMessageForSpeech(input);
    expect(result).toBe(expected);
    expect(result.length).toBeGreaterThan(0);
  });

  it("never returns an empty string for any Latin/digit-only input, even a lone separator-joined token", () => {
    for (const input of ["HTTP", "500", "0", "a", "Z", "OBS2", "v5.5", "2-0", "WK79"]) {
      expect(normalizeMessageForSpeech(input).length).toBeGreaterThan(0);
    }
  });
});

describe("normalizeMessageForSpeech - display text and Cyrillic-only semantics are never touched (WK-82 audit)", () => {
  it("is byte-for-byte identical on pure Cyrillic input, including punctuation and hyphenated compounds", () => {
    const cyrillicOnly = [
      "сегодня сыграл три игры подряд",
      "какой-то результат, но не то что ждали!",
      "а тебе снилось, что ты бабочка? или бабочке снилось, что это ты?",
      "го на следующую катку",
    ];
    for (const text of cyrillicOnly) expect(normalizeMessageForSpeech(text)).toBe(text);
  });

  it("normalizeMessageForSpeech never mutates the string passed to it (no in-place side effects)", () => {
    const input = "RTX 5060 норм";
    const before = input;
    normalizeMessageForSpeech(input);
    expect(input).toBe(before);
  });

  // Displayed chat text is a completely separate field from speechText -
  // this is enforced end-to-end in chat-model.test.ts's
  // "normalizes the username and message for speech without touching the
  // displayed message" test (buildSpeechParts/prepareTtsText never mutate
  // message.text/message.author); this file only proves the pure function
  // itself never touches display state, since it doesn't have access to
  // message.text at all.
});
