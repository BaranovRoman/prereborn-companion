import { describe, expect, it } from "vitest";
import { DEFAULT_CHAT_SETTINGS, prepareTtsText, speechTextFor, type ChatSettings } from "./chat-model";
import type { TwitchChatMessage } from "../core/api";
import {
  applyPronunciations, MAX_PRONUNCIATION_RULES, normalizePronunciationRules, validatePronunciationRule,
  type PronunciationRule, type PronunciationScope,
} from "./pronunciation";

let next = 0;
const rule = (source: string, spoken: string, scope: PronunciationScope = { kind: "global" }, enabled = true): PronunciationRule =>
  ({ id: `r${next++}`, source, spoken, enabled, scope });
const viewer = (login: string, userId: string | null = null): PronunciationScope => ({ kind: "user", login, userId });
const author = (login: string, id: string | null = null) => ({ id, login, name: login });

describe("built-in pronunciations", () => {
  it.each([["хз", "хэзэ"], ["ХЗ", "хэзэ"], ["Хз", "хэзэ"], ["тб", "тэбэ"], ["ТБ", "тэбэ"]])("speaks %s as %s", (input, spoken) => {
    expect(applyPronunciations(input, [])).toBe(spoken);
  });

  it("replaces whole words only, keeping the rest of the message", () => {
    expect(applyPronunciations("ну хз, тб виднее", [])).toBe("ну хэзэ, тэбэ виднее");
    expect(applyPronunciations("хз.", [])).toBe("хэзэ.");
    for (const word of ["тбилиси", "хзх", "отб", "тб2", "ахз"]) expect(applyPronunciations(word, [])).toBe(word);
  });

  it("goes through the full speech pipeline", () => {
    expect(speechTextFor("хз ахахаха +25", DEFAULT_CHAT_SETTINGS)).toBe("хэзэ аха-ха-ха плюс двадцать пять");
  });
});

describe("user dictionary", () => {
  it("applies global rules case-insensitively, as whole words and phrases", () => {
    const rules = [rule("имба", "и+мба"), rule("гг вп", "гуд гейм, вел плейд")];
    expect(applyPronunciations("ИМБА, гг  вп", rules)).toBe("и+мба, гуд гейм, вел плейд");
    expect(applyPronunciations("имбалансный", rules)).toBe("имбалансный");
  });

  it("ignores disabled rules", () => {
    expect(applyPronunciations("имба", [rule("имба", "и+мба", { kind: "global" }, false)])).toBe("имба");
  });

  it("prefers the viewer's rule, then a global rule, then the built-in one", () => {
    const rules = [rule("хз", "не знаю"), rule("хз", "хызы", viewer("roma"))];
    expect(applyPronunciations("хз", rules, author("roma"))).toBe("хызы");
    expect(applyPronunciations("хз", rules, author("other"))).toBe("не знаю");
    expect(applyPronunciations("хз", [rule("хз", "хызы", viewer("roma"))], author("other"))).toBe("хэзэ");
  });

  it("matches a personal rule by the stable Twitch id when both sides have one", () => {
    const rules = [rule("кек", "кэк", viewer("old_name", "42"))];
    expect(applyPronunciations("кек", rules, author("new_name", "42"))).toBe("кэк");
    // Someone who later takes the old login is a different person.
    expect(applyPronunciations("кек", rules, author("old_name", "99"))).toBe("кек");
    // Without an id on the message the login is the fallback.
    expect(applyPronunciations("кек", rules, author("OLD_NAME"))).toBe("кэк");
    expect(applyPronunciations("кек", [rule("кек", "кэк", viewer("@Roma"))], author("roma", "7"))).toBe("кэк");
  });

  it("never applies personal rules to a message without a known author", () => {
    expect(applyPronunciations("кек", [rule("кек", "кэк", viewer("roma"))])).toBe("кек");
  });

  it("prefers the longer source inside the same level", () => {
    const rules = [rule("гг", "гэгэ"), rule("гг вп", "гуд гейм")];
    expect(applyPronunciations("гг вп гг", rules)).toBe("гуд гейм гэгэ");
  });

  it("replaces once: no cycles and no cascades", () => {
    const rules = [rule("а", "б"), rule("б", "а"), rule("кек", "лол"), rule("лол", "кек")];
    expect(applyPronunciations("а б кек лол", rules)).toBe("б а лол кек");
    expect(applyPronunciations("хз", [rule("хз", "тб")])).toBe("тб");
  });

  it("caps how much one message may grow", () => {
    const long = "о".repeat(120);
    const spoken = applyPronunciations(Array(20).fill("кек").join(" "), [rule("кек", long)]);
    expect(spoken.length).toBeLessThan(20 * 3 + 600);
    expect(spoken).toContain(long);
    expect(spoken.endsWith("кек")).toBe(true);
  });

  it("treats regex characters in a source literally", () => {
    expect(applyPronunciations("c++ и c+", [rule("c++", "си плюс плюс")])).toBe("си плюс плюс и c+");
  });
});

describe("validatePronunciationRule", () => {
  const global = { kind: "global" } as const;
  it("rejects empty, symbol-only and oversized text", () => {
    expect(validatePronunciationRule({ source: " ", spoken: "x", scope: global }, [])).toMatch(/исходный/i);
    expect(validatePronunciationRule({ source: "!!!", spoken: "x", scope: global }, [])).toMatch(/буквы/);
    expect(validatePronunciationRule({ source: "кек", spoken: " ", scope: global }, [])).toMatch(/произносить/);
    expect(validatePronunciationRule({ source: "к".repeat(61), spoken: "x", scope: global }, [])).toMatch(/60/);
    expect(validatePronunciationRule({ source: "кек", spoken: "x".repeat(121), scope: global }, [])).toMatch(/120/);
    expect(validatePronunciationRule({ source: "кек", spoken: "кэк", scope: viewer(" ") }, [])).toMatch(/ник/);
  });

  it("rejects a second rule for the same text in the same scope only", () => {
    const rules = [rule("Кек", "кэк"), rule("кек", "кэк", viewer("roma", "1"))];
    expect(validatePronunciationRule({ source: "кек ", spoken: "x", scope: global }, rules)).toMatch(/уже есть/);
    expect(validatePronunciationRule({ source: "кек", spoken: "x", scope: viewer("ROMA") }, rules)).toMatch(/уже есть/);
    expect(validatePronunciationRule({ source: "кек", spoken: "x", scope: viewer("renamed", "1") }, rules)).toMatch(/уже есть/);
    expect(validatePronunciationRule({ source: "кек", spoken: "x", scope: viewer("other") }, rules)).toBeNull();
    // Editing a rule doesn't conflict with itself.
    expect(validatePronunciationRule({ source: "кек", spoken: "кэээк", scope: global }, rules, rules[0].id)).toBeNull();
  });

  it("limits the number of rules", () => {
    const many = Array.from({ length: MAX_PRONUNCIATION_RULES }, (_, i) => rule(`слово${i}`, "x"));
    expect(validatePronunciationRule({ source: "новое", spoken: "x", scope: global }, many)).toMatch(/300/);
  });
});

describe("normalizePronunciationRules", () => {
  it("keeps valid persisted rules and drops anything malformed", () => {
    const stored = JSON.parse(JSON.stringify([
      rule(" кек ", " кэк "),
      rule("тб", "тэбэ", viewer("@Roma", "5"), false),
      { id: "x", source: "", spoken: "y", enabled: true, scope: { kind: "global" } },
      { id: "y", source: "a", spoken: "b", enabled: true, scope: { kind: "user" } },
      { id: "z", source: "a", spoken: "b", scope: { kind: "team" } },
      "garbage", null,
    ]));
    const rules = normalizePronunciationRules(stored);
    expect(rules).toHaveLength(2);
    expect(rules[0]).toMatchObject({ source: "кек", spoken: "кэк", enabled: true });
    expect(rules[1]).toMatchObject({ enabled: false, scope: { kind: "user", login: "roma", userId: "5" } });
    expect(normalizePronunciationRules(undefined)).toEqual([]);
    expect(normalizePronunciationRules({})).toEqual([]);
  });
});

describe("chat messages", () => {
  const message = (text: string, authorLogin = "roma", authorId: string | null = "1"): TwitchChatMessage => ({
    id: `m${next++}`, author: "Roma", authorId, authorLogin, color: null, text, badges: [], messageType: "text", receivedAt: "",
  });
  const settings: ChatSettings = {
    ...DEFAULT_CHAT_SETTINGS, ttsEnabled: true, speakAuthor: false,
    pronunciationRules: [rule("кек", "кэк"), rule("лол", "лолик", viewer("roma", "1"))],
  };

  it("speaks the transformed text and never changes the original message", () => {
    const raw = message("кек лол хз ахахаха +25 https://clips.twitch.tv/Abc+1");
    const before = structuredClone(raw);
    expect(prepareTtsText(raw, settings)).toBe("кэк лолик хэзэ аха-ха-ха плюс двадцать пять ссылка");
    expect(raw).toEqual(before);
    expect(settings.pronunciationRules[0].spoken).toBe("кэк");
  });

  it("applies a viewer's rule only to that viewer's messages", () => {
    expect(prepareTtsText(message("лол", "someone", "2"), settings)).toBe("лол");
  });
});
