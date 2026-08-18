import { describe, expect, it } from "vitest";
import { normalizeMessageForSpeech, normalizeUsernameForSpeech } from "./tts-normalize";

describe("normalizeUsernameForSpeech", () => {
  it("leaves an ordinary Russian username as-is", () => {
    expect(normalizeUsernameForSpeech("Роман")).toBe("Роман");
  });

  it("leaves an ordinary Latin username as-is", () => {
    expect(normalizeUsernameForSpeech("Alex")).toBe("Alex");
  });

  it("turns underscores into pauses between name parts", () => {
    expect(normalizeUsernameForSpeech("Roma_Romych")).toBe("Roma Romych");
  });

  it("separates letters from digits instead of reading them glued together", () => {
    expect(normalizeUsernameForSpeech("Player228")).toBe("Player 228");
  });

  it("drops a long digit run (id-like suffix) but keeps a short one", () => {
    expect(normalizeUsernameForSpeech("xqc_48210394")).toBe("xqc");
    expect(normalizeUsernameForSpeech("Player7")).toBe("Player 7");
  });

  it("strips a trailing TV/TTV suffix", () => {
    expect(normalizeUsernameForSpeech("Roma_Romych_TV")).toBe("Roma Romych");
    expect(normalizeUsernameForSpeech("StreamerTTV")).not.toContain("TTV");
  });

  it("matches the example from the task: Roma_Romych_TV reads as a name, not a raw handle", () => {
    const spoken = normalizeUsernameForSpeech("Roma_Romych_TV");
    expect(spoken).toBe("Roma Romych");
  });

  it("collapses repeated characters within a token", () => {
    expect(normalizeUsernameForSpeech("xXxAAAAAxXx")).toBe("xXxAAxXx");
  });

  it("drops an unreadable consonant-only fragment but keeps a readable one", () => {
    expect(normalizeUsernameForSpeech("qzxkrpt_Roma")).toBe("Roma");
  });

  it("never goes silent - falls back to the original when everything is filtered out", () => {
    expect(normalizeUsernameForSpeech("TTV")).toBe("TTV");
  });

  it("does not rewrite a mixed Cyrillic/Latin username, only cleans separators", () => {
    expect(normalizeUsernameForSpeech("Роман-Roman")).toBe("Роман Roman");
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
});
