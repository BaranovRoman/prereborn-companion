import type { ObsConfig } from "../types/status";

export const sceneMappings = [
  { key: "between_matches_scene", label: "Между матчами" },
  { key: "draft_scene", label: "Драфт" },
  { key: "gameplay_scene", label: "Игра" },
] as const satisfies ReadonlyArray<{
  key: keyof Pick<ObsConfig, "between_matches_scene" | "draft_scene" | "gameplay_scene">;
  label: string;
}>;

export function missingMappedScenes(config: ObsConfig, scenes: string[] | null): string[] {
  if (scenes === null) return [];
  return sceneMappings
    .map(({ key }) => config[key].trim())
    .filter((name) => name.length > 0 && !scenes.includes(name));
}

export function sceneOptions(current: string, scenes: string[] | null): string[] {
  if (scenes === null) return current ? [current] : [];
  return current && !scenes.includes(current) ? [current, ...scenes] : scenes;
}
