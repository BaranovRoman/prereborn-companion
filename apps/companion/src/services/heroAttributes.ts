// WK-121 - consolidated into heroCatalog.ts (the one canonical TS-side hero
// catalog for Companion, see its doc comment). Kept as a thin re-export so
// existing imports don't need touching.
export type { DotaHeroAttribute } from "./heroCatalog";
export { getHeroAttribute } from "./heroCatalog";
