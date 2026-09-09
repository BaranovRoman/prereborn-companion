import type { DotaCountBucket, DotaPlayerHeroStats } from "./dota-match-provider.js";
import { computeHeroLifetimeStats, type HeroLifetimeStats } from "./opendota-hero-insights-formulas.js";

// Player-summary rows next to Player Radar (задача: "very small player
// summary... not cards and not explanations of radar axes"). Chistye
// vychisleniya (no I/O), same philosophy as opendota-player-profile-radar.ts
// - every value here is derived from OpenDota responses this feature already
// fetches for Favorite Heroes/Radar (see opendota-overlay-insights-cache-
// service.ts's getCachedOverlayPlayerSummary), not a new upstream call.

// "МАТЧЕЙ" row - same lifetime games/wins math as
// computeHeroLifetimeStats, just summed across every hero in the already-
// cached GET /players/{id}/heroes response instead of one pinned hero.
export const computeAccountLifetimeStats = (
    heroes: DotaPlayerHeroStats[]
): HeroLifetimeStats | null => {
    const games = heroes.reduce((sum, hero) => sum + hero.games, 0);
    const wins = heroes.reduce((sum, hero) => sum + hero.wins, 0);
    return computeHeroLifetimeStats(games, wins);
};

// "ГЕРОЕВ" row - count of heroes with games > 0 in the same already-cached
// /heroes response. No minimum-match threshold per hero (задача: "do not
// introduce an arbitrary minimum-match threshold unless there is an existing
// product convention" - none exists for this row).
export const computeHeroesPlayedCount = (heroes: DotaPlayerHeroStats[]): number =>
    heroes.filter((hero) => hero.games > 0).length;

// "ОСН. РОЛЬ" row - OpenDota's own lane_role codes (verified against
// odota/web's own localization strings, src/lang/{en-US,ru-RU}.json:
// lane_role_0 "Unknown"/"Неизвестно", _1 "Safe"/"Лёгкая", _2 "Mid"/"Средняя",
// _3 "Off"/"Сложная", _4 "Jungle"/"Лес" - the same numeric codes GET
// /players/{id}/counts's lane_role buckets use). Labelled here with the
// informal Russian role names this app's own Dota-fluent audience actually
// uses (Керри/Мид/Оффлейн/Лес) rather than OpenDota's literal lane
// translation, since the row is framed as "ОСН. РОЛЬ" (role), not a lane
// name - lane_role remains a proxy for role (a support can play safe lane
// too), not a perfect measurement, which is why this is presented as "most
// played lane" rather than anything stronger.
export const LANE_ROLE_LABELS: Record<number, string> = {
    0: "—",
    1: "Керри",
    2: "Мид",
    3: "Оффлейн",
    4: "Лес",
};

export interface MainRoleSummary {
    code: number;
    label: string;
    games: number;
}

// Picks the lane_role bucket with the most games - the same
// countsResult.counts.laneRole the radar's flexibility axis already reads
// (opendota-player-profile-radar.ts), just keeping the bucket KEY here
// instead of discarding it. Unknown codes (outside the 5 verified above) or
// an all-empty/missing counts response return null - no guessed role from
// data this app can't actually support (задача: "do not guess a role if our
// existing data cannot support it reliably").
export const computeMainRole = (
    roleCounts: Record<string, DotaCountBucket> | null
): MainRoleSummary | null => {
    if (!roleCounts) return null;
    let best: { code: number; games: number } | null = null;
    for (const [key, bucket] of Object.entries(roleCounts)) {
        if (bucket.games <= 0) continue;
        const code = Number(key);
        if (!Number.isFinite(code)) continue;
        if (!best || bucket.games > best.games) best = { code, games: bucket.games };
    }
    if (!best) return null;
    const label = LANE_ROLE_LABELS[best.code];
    if (!label) return null;
    return { code: best.code, label, games: best.games };
};
