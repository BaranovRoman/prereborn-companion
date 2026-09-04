import type { DotaCountBucket, DotaHeroMatch, DotaPlayerTotals, DotaStatTotal } from "./dota-match-provider.js";

// WK-148 - чистые вычисления над уже полученными данными OpenDota (никакого
// I/O), задача, секция 2/14: "K/D/A, GPM, XPM ... require ... reliable and
// sufficiently sampled" + "не считать среднее по 1 случайно распарсенному
// матчу". Вынесено из контроллера/кэш-сервисов, чтобы формулы были
// тестируемы напрямую, без моков сети/кэша.

export interface HeroRecentForm {
    sample: number;
    wins: number;
    losses: number;
    winRate: number;
}

// "ПОСЛЕДНИЕ N" - N = реальное число матчей в выборке (может быть < лимита
// запроса), никогда не выдаём фиксированное "20", если матчей меньше
// (задача, секция 2.A: "Do not imply a sample of 20 if fewer matches exist").
export const computeRecentForm = (matches: DotaHeroMatch[]): HeroRecentForm | null => {
    if (matches.length === 0) return null;
    const wins = matches.filter((match) => match.isWin).length;
    const sample = matches.length;
    return {
        sample,
        wins,
        losses: sample - wins,
        winRate: (wins / sample) * 100,
    };
};

export interface HeroLifetimeStats {
    games: number;
    wins: number;
    losses: number;
    winRate: number;
}

// Lifetime "MATCHES · WINRATE" line (задача, секция 4 - "Preferred first-line
// information") - тот же расчёт, что уже использует
// getOpenDotaHeroStatsController (WK-133), вынесен сюда как переиспользуемая
// чистая функция для Between Matches enrichment.
export const computeHeroLifetimeStats = (games: number, wins: number): HeroLifetimeStats | null => {
    if (games <= 0) return null;
    return {
        games,
        wins,
        losses: games - wins,
        winRate: (wins / games) * 100,
    };
};

export interface HeroPatchStats {
    patchId: number;
    games: number;
    wins: number;
    losses: number;
    winRate: number;
}

// Если игрок не играл на резолвленном текущем патче этим героем - бакет
// отсутствует или games === 0 - блок должен быть омитнут вызывающим кодом, а
// не показан как "0 матчей · —%" (задача, секция 2.B).
export const computeHeroPatchStats = (
    patchCounts: Record<string, DotaCountBucket>,
    patchId: number
): HeroPatchStats | null => {
    const bucket = patchCounts[String(patchId)];
    if (!bucket || bucket.games <= 0) return null;
    return {
        patchId,
        games: bucket.games,
        wins: bucket.win,
        losses: bucket.games - bucket.win,
        winRate: (bucket.win / bucket.games) * 100,
    };
};

// Ниже какого числа parsed-матчей среднее не показываем вовсе - "не считать
// среднее по 1 случайно распарсенному матчу" (задача, секция 2.C). Применимо
// к hero_damage/tower_damage/hero_healing - они требуют parsed replay и
// доступны не для всех игр.
export const MIN_PARSED_SAMPLE = 5;

export const averageStatTotal = (
    total: DotaStatTotal,
    minSample = 1
): number | null => (total.n >= minSample ? total.sum / total.n : null);

export interface HeroKdaAverages {
    kills: number | null;
    deaths: number | null;
    assists: number | null;
    goldPerMin: number | null;
    xpPerMin: number | null;
}

// KDA/GPM/XPM не требуют parsed-реплея - надёжны почти для всех игр
// (задача, секция 2.C), поэтому minSample=1 (просто "есть хоть один
// засчитанный матч"), в отличие от parsed-only полей ниже.
export const computeHeroKdaAverages = (totals: DotaPlayerTotals): HeroKdaAverages => ({
    kills: averageStatTotal(totals.kills),
    deaths: averageStatTotal(totals.deaths),
    assists: averageStatTotal(totals.assists),
    goldPerMin: averageStatTotal(totals.goldPerMin),
    xpPerMin: averageStatTotal(totals.xpPerMin),
});

export interface HeroParsedAverages {
    heroDamage: number | null;
    towerDamage: number | null;
    heroHealing: number | null;
}

export const computeHeroParsedAverages = (totals: DotaPlayerTotals): HeroParsedAverages => ({
    heroDamage: averageStatTotal(totals.heroDamage, MIN_PARSED_SAMPLE),
    towerDamage: averageStatTotal(totals.towerDamage, MIN_PARSED_SAMPLE),
    heroHealing: averageStatTotal(totals.heroHealing, MIN_PARSED_SAMPLE),
});
