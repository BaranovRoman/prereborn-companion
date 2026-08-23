// Статичная медаль ранга в gameplay MMR widget (см. задачу WK-85). В проекте
// нет сохранённого rank_tier/медали стримера и OpenDota-интеграция
// (dota-match-provider.ts) сегодня не запрашивает и не хранит такое поле -
// заводить новый backend/data pipeline ради одной медали избыточно (задача
// прямо просит не выдумывать источник и сначала проверить приоритет 1-2:
// уже имеющиеся данные, затем deterministic mapping из уже имеющегося
// rating). Ниже - deterministic mapping из session.rating (то же число, что
// уже показывает виджет как "{rating} MMR") на медаль по официальным
// tier-порогам Dota 2 - те же самые пороги, что уже используются в проекте
// для donation-рангов (см. DONATION_RANKS в queue-scene-ui.tsx), просто для
// другой цели: там - донат в валюте, здесь - реальный MMR. Пороги
// продублированы (не импортированы оттуда), чтобы не завязывать
// donation-фичу и rank-медаль друг на друга - у них разное назначение и они
// должны меняться независимо.
const RANK_TIER_THRESHOLDS: { tier: string; thresholds: number[] }[] = [
    { tier: "herald", thresholds: [0, 154, 308, 462, 616] },
    { tier: "guardian", thresholds: [770, 924, 1_078, 1_232, 1_386] },
    { tier: "crusader", thresholds: [1_540, 1_694, 1_848, 2_002, 2_156] },
    { tier: "archon", thresholds: [2_310, 2_464, 2_618, 2_772, 2_926] },
    { tier: "legend", thresholds: [3_080, 3_234, 3_388, 3_542, 3_696] },
    { tier: "ancient", thresholds: [3_850, 4_004, 4_158, 4_312, 4_466] },
    { tier: "divine", thresholds: [4_620, 4_820, 5_020, 5_220, 5_420] },
];
const IMMORTAL_THRESHOLD = 5_620;

const TIER_LABELS: Record<string, string> = {
    herald: "Herald",
    guardian: "Guardian",
    crusader: "Crusader",
    archon: "Archon",
    legend: "Legend",
    ancient: "Ancient",
    divine: "Divine",
};

export interface RankMedal {
    // Путь к уже существующему ассету в apps/web/public/vendor/valve/rank-medals/
    // (см. задачу - переиспользуем, не создаём новый набор графики).
    fileName: string;
    label: string;
}

// null - неизвестный ранг (rating ещё не задан или отрицателен) - вызывающая
// сторона должна аккуратно не рендерить медаль вовсе (graceful fallback, см.
// задачу), а не подставлять медаль-заглушку.
export const getRankMedal = (rating: number | null): RankMedal | null => {
    if (rating === null || rating < 0) return null;
    if (rating >= IMMORTAL_THRESHOLD) return { fileName: "immortal.png", label: "Immortal" };

    let match: { tier: string; division: number } | null = null;
    for (const { tier, thresholds } of RANK_TIER_THRESHOLDS) {
        for (let index = 0; index < thresholds.length; index += 1) {
            if (rating >= thresholds[index]) {
                match = { tier, division: index + 1 };
            }
        }
    }
    if (!match) return null;

    return {
        fileName: `${match.tier}-${match.division}.png`,
        label: `${TIER_LABELS[match.tier]} ${match.division}`,
    };
};
