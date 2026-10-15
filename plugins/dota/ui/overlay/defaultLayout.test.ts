import { describe, expect, it } from "vitest";
import { DEFAULT_OVERLAY_LAYOUT } from "./defaultLayout";

describe("standalone renderer default layout", () => {
  it("keeps Draft protection and Gameplay widgets visible before saved config arrives", () => {
    expect(DEFAULT_OVERLAY_LAYOUT.draftProtection.mode).toBe("cover");
    expect(DEFAULT_OVERLAY_LAYOUT.scenes.gameplay.widgets.session.visible).toBe(true);
    expect(DEFAULT_OVERLAY_LAYOUT.scenes.gameplay.widgets.recentMatches.visible).toBe(true);
    expect(DEFAULT_OVERLAY_LAYOUT.scenes.gameplay.minimapCover.enabled).toBe(true);
  });
});
