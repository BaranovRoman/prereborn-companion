// Node environment: verifies the CSS contract that Playwright exercises with
// `omitBackground: true` during visual QA.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("../overlay-renderer/overlay-renderer.css", import.meta.url), "utf8");

describe("OBS alpha background", () => {
  it("keeps the document and Between Matches scene transparent", () => {
    expect(css).toMatch(/body\s*\{[\s\S]*?background:\s*transparent;/);
    expect(css).toMatch(/\.ov-background--betweenMatches\s*\{\s*background:\s*transparent;/);
  });
});
