import type { DotaCountBucket, DotaPlayerTotals } from "./dota-match-provider.js";
import { averageStatTotal, MIN_PARSED_SAMPLE } from "./opendota-hero-insights-formulas.js";

// WK-148 - "ПРОФИЛЬ ИГРОКА" (задача, секции 6-10). Чистые вычисления, никакого
// I/O - формулы и анкоры документируются здесь и покрываются юнит-тестами
// напрямую (задача, секция 14 требует именно этого).
//
// OpenDota не отдаёт дёшево глобальный percentile (/distributions - только
// MMR-бакеты, /histograms - персональная гистограмма самого игрока, не
// популяции). Поэтому используется fixed-anchor модель: значение оси - это
// "X% пути от слабого (min) до сильного (max) анкора по этой метрике", а НЕ
// percentile среди игроков Valve. Анкоры ниже - v1, продукт/дизайн может их
// скорректировать позже без изменения формы формул.
export interface RadarAnchor {
    min: number;
    max: number;
}

export const RADAR_ANCHORS = {
    // БОЙ: kills+assists за игру (надёжно, не требует parse) + hero_damage
    // за игру (parsed-only, участвует только при достаточном покрытии).
    combatKillsAssists: { min: 8, max: 28 } satisfies RadarAnchor,
    combatHeroDamage: { min: 5000, max: 30000 } satisfies RadarAnchor,
    // ФАРМ: GPM/XPM/last hits - все три надёжны почти для всех игр.
    farmGpm: { min: 200, max: 750 } satisfies RadarAnchor,
    farmXpm: { min: 250, max: 800 } satisfies RadarAnchor,
    farmLastHits: { min: 30, max: 300 } satisfies RadarAnchor,
    // ПОДДЕРЖКА: assists (надёжно) + hero_healing (parsed-only, бонус).
    supportAssists: { min: 5, max: 25 } satisfies RadarAnchor,
    supportHealing: { min: 0, max: 3000 } satisfies RadarAnchor,
    // ОБЪЕКТЫ: единственный доступный сигнал - tower_damage, целиком
    // parsed-only (задача, секция 7 - "самая слабая по данным ось").
    objectivesTowerDamage: { min: 500, max: 6000 } satisfies RadarAnchor,
    // ГИБКОСТЬ: "эффективное число" героев/ролей (1/HHI) относительно
    // разумного пула - см. computeFlexibilityAxis ниже.
    flexibilityHeroPool: { min: 1, max: 25 } satisfies RadarAnchor,
    flexibilityRolePool: { min: 1, max: 5 } satisfies RadarAnchor,
} as const;

// Значение вида "ФАРМ 72" означает "72% пути от слабого до сильного анкора",
// НЕ "лучше 72% игроков" - это обязательно отражается в копирайте UI, не
// только здесь (задача, секция 9).
export const normalizeToScore = (value: number, anchor: RadarAnchor): number => {
    if (anchor.max === anchor.min) return 0;
    const ratio = (value - anchor.min) / (anchor.max - anchor.min);
    return Math.round(Math.max(0, Math.min(1, ratio)) * 100);
};

export const computeCombatAxis = (totals: DotaPlayerTotals): number | null => {
    const kills = averageStatTotal(totals.kills);
    const assists = averageStatTotal(totals.assists);
    if (kills === null || assists === null) return null;

    const killsAssistsScore = normalizeToScore(kills + assists, RADAR_ANCHORS.combatKillsAssists);
    const heroDamageAvg = averageStatTotal(totals.heroDamage, MIN_PARSED_SAMPLE);
    if (heroDamageAvg === null) return killsAssistsScore;

    const heroDamageScore = normalizeToScore(heroDamageAvg, RADAR_ANCHORS.combatHeroDamage);
    return Math.round((killsAssistsScore + heroDamageScore) / 2);
};

export const computeFarmAxis = (totals: DotaPlayerTotals): number | null => {
    const scores: number[] = [];
    const gpm = averageStatTotal(totals.goldPerMin);
    if (gpm !== null) scores.push(normalizeToScore(gpm, RADAR_ANCHORS.farmGpm));
    const xpm = averageStatTotal(totals.xpPerMin);
    if (xpm !== null) scores.push(normalizeToScore(xpm, RADAR_ANCHORS.farmXpm));
    const lastHits = averageStatTotal(totals.lastHits);
    if (lastHits !== null) scores.push(normalizeToScore(lastHits, RADAR_ANCHORS.farmLastHits));
    if (scores.length === 0) return null;
    return Math.round(scores.reduce((sum, score) => sum + score, 0) / scores.length);
};

export const computeSupportAxis = (totals: DotaPlayerTotals): number | null => {
    const assists = averageStatTotal(totals.assists);
    if (assists === null) return null;

    const assistsScore = normalizeToScore(assists, RADAR_ANCHORS.supportAssists);
    const healingAvg = averageStatTotal(totals.heroHealing, MIN_PARSED_SAMPLE);
    if (healingAvg === null) return assistsScore;

    const healingScore = normalizeToScore(healingAvg, RADAR_ANCHORS.supportHealing);
    // assists надёжны почти всегда, healing - только у части героев/матчей:
    // 70/30 в пользу assists (задача, секция 7).
    return Math.round(assistsScore * 0.7 + healingScore * 0.3);
};

export const computeObjectivesAxis = (totals: DotaPlayerTotals): number | null => {
    const towerDamageAvg = averageStatTotal(totals.towerDamage, MIN_PARSED_SAMPLE);
    if (towerDamageAvg === null) return null;
    return normalizeToScore(towerDamageAvg, RADAR_ANCHORS.objectivesTowerDamage);
};

// Итоговый вес Гибкости: 60% hero-diversity / 40% role-diversity (задача,
// секция 8 - "Initial approved implementation weighting").
export const HERO_DIVERSITY_WEIGHT = 0.6;
export const ROLE_DIVERSITY_WEIGHT = 0.4;

// Ниже скольки lifetime игр доверие к hero/role-разнообразию дампингуется
// линейно к нулю. Без этого "1 игра на 50 героях" (HHI-based effective count
// = 50, у максимума анкора) давала бы лже-максимальную Гибкость на почти
// нулевой выборке - явно запрещённый в задаче анти-кейс (секция 8: "avoid
// the trivial failure where playing one game each on 50 heroes produces
// '100 flexibility'"). 300 - v1-порог: "несколько сотен игр" читается как
// "это реально твой пул героев", а не всплеск экспериментов за пару недель.
export const FLEXIBILITY_CONFIDENCE_SATURATION_GAMES = 300;

// Минимальная lifetime-выборка, ниже которой радар вообще не считается -
// показывается restrained "недостаточно данных" вместо результата (задача,
// секция 10). 30 игр - минимум, при котором игрок хоть немного "устоялся" в
// своём стиле, а не 2-3 случайные игры.
export const MIN_RADAR_SAMPLE_GAMES = 30;

const computeHhiEffectiveCount = (games: number[]): number => {
    const total = games.reduce((sum, value) => sum + value, 0);
    if (total <= 0) return 0;
    const hhi = games.reduce((sum, value) => sum + (value / total) ** 2, 0);
    return hhi > 0 ? 1 / hhi : 0;
};

const confidenceFactor = (totalGames: number): number =>
    Math.max(0, Math.min(1, totalGames / FLEXIBILITY_CONFIDENCE_SATURATION_GAMES));

export interface FlexibilityInput {
    // games > 0 по каждому герою, из уже закэшированного GET /players/{id}/heroes.
    heroGames: number[];
    // games по каждому lane_role бакету из GET /players/{id}/counts (без
    // hero_id) - null, если /counts недоступен (не "нет данных", а именно
    // "не пришло").
    roleGames: number[] | null;
}

export const computeFlexibilityAxis = ({ heroGames, roleGames }: FlexibilityInput): number | null => {
    const totalHeroGames = heroGames.reduce((sum, value) => sum + value, 0);
    if (totalHeroGames <= 0) return null;

    const heroEffective = computeHhiEffectiveCount(heroGames);
    const heroScore = normalizeToScore(heroEffective, RADAR_ANCHORS.flexibilityHeroPool);
    const dampedHeroScore = heroScore * confidenceFactor(totalHeroGames);

    const totalRoleGames = roleGames?.reduce((sum, value) => sum + value, 0) ?? 0;
    if (!roleGames || totalRoleGames <= 0) {
        // role-данные недоступны/пусты - откатываемся на чистое
        // hero-разнообразие, а не скрываем весь профиль (задача, секция 8).
        return Math.round(dampedHeroScore);
    }

    const roleEffective = computeHhiEffectiveCount(roleGames);
    const roleScore = normalizeToScore(roleEffective, RADAR_ANCHORS.flexibilityRolePool);
    const dampedRoleScore = roleScore * confidenceFactor(totalRoleGames);

    return Math.round(
        HERO_DIVERSITY_WEIGHT * dampedHeroScore + ROLE_DIVERSITY_WEIGHT * dampedRoleScore
    );
};

export const hasSufficientRadarSample = (totalGames: number): boolean =>
    totalGames >= MIN_RADAR_SAMPLE_GAMES;

export interface PlayerProfileRadar {
    combat: number | null;
    farm: number | null;
    support: number | null;
    objectives: number | null;
    flexibility: number | null;
    insufficientSample: boolean;
}

export const computePlayerProfileRadar = (
    totals: DotaPlayerTotals,
    heroGamesByHero: number[],
    roleCounts: Record<string, DotaCountBucket> | null
): PlayerProfileRadar => {
    const totalGames = heroGamesByHero.reduce((sum, value) => sum + value, 0);
    if (!hasSufficientRadarSample(totalGames)) {
        return {
            combat: null,
            farm: null,
            support: null,
            objectives: null,
            flexibility: null,
            insufficientSample: true,
        };
    }

    const roleGames = roleCounts ? Object.values(roleCounts).map((bucket) => bucket.games) : null;
    return {
        combat: computeCombatAxis(totals),
        farm: computeFarmAxis(totals),
        support: computeSupportAxis(totals),
        objectives: computeObjectivesAxis(totals),
        flexibility: computeFlexibilityAxis({ heroGames: heroGamesByHero, roleGames }),
        insufficientSample: false,
    };
};
