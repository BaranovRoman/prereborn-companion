import { describe, expect, it } from "vitest";
import { joinMediaUrl, normalizeMediaBaseUrl } from "./media";

describe("normalizeMediaBaseUrl", () => {
  it("removes trailing slashes from an absolute origin", () => {
    expect(normalizeMediaBaseUrl("https://prereborn.ru/media///")).toBe(
      "https://prereborn.ru/media"
    );
  });

  it("keeps a relative media base for local development", () => {
    expect(normalizeMediaBaseUrl("/media")).toBe("/media");
  });

  it("joins an HTTPS base and relative media path", () => {
    expect(
      joinMediaUrl("https://prereborn.ru/media/", "/dota/heroes/axe.webm")
    ).toBe("https://prereborn.ru/media/dota/heroes/axe.webm");
  });
});
