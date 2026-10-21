/// <reference types="vite/client" />
import { describe, expect, it } from "vitest";

// Companion hosts plugin UIs in sandbox="allow-scripts" (no allow-forms): a
// form submit is silently dropped there and its onSubmit never runs. That was
// the WK-183 0.1.0 «Сохранить» bug; keep forms out of this package.
const sources = import.meta.glob<string>(["./**/*.tsx", "../widget/**/*.tsx", "!./**/*.test.tsx"], { query: "?raw", import: "default", eager: true });

describe("sandboxed plugin UI", () => {
  it("uses no <form> elements and no submit buttons", () => {
    expect(Object.keys(sources).length).toBeGreaterThan(3);
    for (const [file, source] of Object.entries(sources)) {
      expect(source, file).not.toMatch(/<form[\s>]|onSubmit|type="submit"/);
    }
  });
});
