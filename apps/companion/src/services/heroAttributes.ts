// WK-116 - ported verbatim from
// apps/web/src/entities/dota-hero/model/attributes.ts, used to group
// HeroesGrid.tsx into the same Strength/Agility/Intelligence/Universal
// columns as web's Favorite Heroes picker (see queue-widgets-panel.tsx).
export type DotaHeroAttribute = "strength" | "agility" | "intelligence" | "universal";

const ATTRIBUTE_IDS: Record<DotaHeroAttribute, ReadonlySet<number>> = {
  strength: new Set([73, 2, 99, 96, 81, 51, 135, 69, 49, 107, 7, 103, 59, 23, 155, 104, 54, 77, 129, 60, 84, 57, 110, 137, 14, 28, 71, 18, 29, 98, 19, 83, 100, 108, 85, 42]),
  agility: new Set([1, 4, 62, 61, 56, 6, 106, 41, 72, 123, 8, 145, 80, 48, 94, 82, 9, 114, 10, 89, 44, 12, 15, 32, 11, 93, 35, 67, 46, 109, 95, 70, 20, 47, 63]),
  intelligence: new Set([68, 66, 5, 55, 119, 87, 58, 121, 74, 64, 90, 52, 31, 25, 26, 138, 36, 111, 76, 13, 45, 39, 131, 86, 79, 27, 75, 101, 17, 34, 37, 112, 30, 22]),
  universal: new Set([102, 113, 3, 65, 38, 78, 50, 43, 33, 91, 97, 136, 53, 88, 120, 16, 128, 105, 40, 92, 126, 21]),
};

export const getHeroAttribute = (heroId: number): DotaHeroAttribute => {
  for (const [attribute, ids] of Object.entries(ATTRIBUTE_IDS) as Array<[DotaHeroAttribute, ReadonlySet<number>]>) {
    if (ids.has(heroId)) return attribute;
  }
  return "universal";
};
