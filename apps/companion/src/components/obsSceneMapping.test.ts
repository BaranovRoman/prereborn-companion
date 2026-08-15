import { describe, expect, it } from "vitest";
import type { ObsConfig } from "../types/status";
import { missingMappedScenes, sceneOptions } from "./obsSceneMapping";

const config: ObsConfig = {
  enabled: true,
  host: "127.0.0.1",
  port: 4455,
  password: "",
  between_matches_scene: "Queue",
  draft_scene: "Missing draft",
  gameplay_scene: "Gameplay",
};

describe("OBS scene mapping", () => {
  it("preserves saved values while OBS is unavailable", () => {
    expect(sceneOptions(config.draft_scene, null)).toEqual(["Missing draft"]);
    expect(missingMappedScenes(config, null)).toEqual([]);
  });

  it("keeps a missing saved value visible without replacing it", () => {
    expect(sceneOptions(config.draft_scene, ["Queue", "Gameplay"])).toEqual([
      "Missing draft",
      "Queue",
      "Gameplay",
    ]);
    expect(missingMappedScenes(config, ["Queue", "Gameplay"])).toEqual(["Missing draft"]);
  });

  it("does not duplicate a valid current value", () => {
    expect(sceneOptions(config.gameplay_scene, ["Queue", "Gameplay"])).toEqual([
      "Queue",
      "Gameplay",
    ]);
  });
});
