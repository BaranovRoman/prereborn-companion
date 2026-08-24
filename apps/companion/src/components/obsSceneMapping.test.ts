import { describe, expect, it } from "vitest";
import type { ObsConfig } from "../types/status";
import { missingMappedScenes, sceneMappings, sceneOptions } from "./obsSceneMapping";

const config: ObsConfig = {
  enabled: true,
  host: "127.0.0.1",
  port: 4455,
  password: "",
  between_matches_scene: "Queue",
  draft_scene: "Missing draft",
  gameplay_scene: "Gameplay",
  post_stream_scene: "Post Stream",
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
    // "Post Stream" (config.post_stream_scene) included here so this case
    // stays isolated to the one intentionally-missing mapping (draft) -
    // see the dedicated WK-99 test below for post_stream_scene itself.
    expect(missingMappedScenes(config, ["Queue", "Gameplay", "Post Stream"])).toEqual([
      "Missing draft",
    ]);
  });

  it("does not duplicate a valid current value", () => {
    expect(sceneOptions(config.gameplay_scene, ["Queue", "Gameplay"])).toEqual([
      "Queue",
      "Gameplay",
    ]);
  });

  // WK-99 - Post Stream is a fourth binding "наравне" (on equal footing)
  // with the other three, not a special case bolted on separately.
  it("treats post_stream_scene as an equal fourth binding", () => {
    expect(sceneMappings).toHaveLength(4);
    expect(sceneMappings.map((mapping) => mapping.key)).toContain("post_stream_scene");
    expect(missingMappedScenes(config, ["Queue", "Missing draft", "Gameplay"])).toEqual([
      "Post Stream",
    ]);
  });
});
