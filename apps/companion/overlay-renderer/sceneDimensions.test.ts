import { describe, expect, it } from "vitest";
import { resolveSceneDimensions } from "./sceneDimensions";
import type { OverlayLayout } from "./types";

describe("resolveSceneDimensions", () => {
  it("uses the persisted virtual canvas instead of deriving another 1920-based scene", () => {
    const layout = { aspectRatio: { preset: "16:9", widthRatio: 16, heightRatio: 9, width: 2560, height: 1440 } } as OverlayLayout;
    expect(resolveSceneDimensions(layout)).toEqual({ width: 2560, height: 1440 });
  });
});
