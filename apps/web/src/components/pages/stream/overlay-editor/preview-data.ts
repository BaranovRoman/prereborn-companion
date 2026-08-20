import type { StreamMatch } from "@/entities/stream-session/model/types";

// Статичные тестовые данные для превью редактора - не бьём в реальный
// overlay endpoint ради этого (см. задачу: "тестовые/текущие данные"), а
// сами виджеты (SessionStats/CurrentGame/RecentMatches/CompanionStatus) -
// те же самые компоненты, что рендерятся на настоящем /overlay/:token.
// 8 матчей - специально больше дефолтного limit (5), чтобы в редакторе сразу
// было видно поведение "+N ещё" (см. задачу, п.7), а не только пустой кейс.
// sessionRatingDelta = 7205 (текущий) - 7155 (ratingBefore самого раннего
// матча ниже, preview-8) - см. session-stats.tsx.
export const PREVIEW_SESSION = { rating: 7205, sessionRatingDelta: 50, wins: 5, losses: 3 };
export const PREVIEW_LAST_HERO_ID = 14; // Pudge
export const PREVIEW_GAME_MODE = "ranked" as const;

const minutesAgo = (minutes: number) =>
    new Date(Date.now() - minutes * 60_000).toISOString();

export const PREVIEW_MATCHES: StreamMatch[] = [
    {
        id: "preview-1",
        dotaMatchId: "8920415764",
        inventory: [],
        heroId: 14,
        kills: 12,
        deaths: 6,
        assists: 18,
        result: "win",
        ratingBefore: 7180,
        ratingDelta: 25,
        ratingAfter: 7205,
        gameMode: "ranked",
        endedAt: minutesAgo(2),
    },
    {
        id: "preview-2",
        dotaMatchId: "8920415763",
        inventory: [],
        heroId: 9,
        kills: 4,
        deaths: 9,
        assists: 10,
        result: "loss",
        ratingBefore: 7205,
        ratingDelta: -25,
        ratingAfter: 7180,
        gameMode: "ranked",
        endedAt: minutesAgo(35),
    },
    {
        id: "preview-3",
        dotaMatchId: "8920415762",
        inventory: [],
        heroId: 1,
        kills: 20,
        deaths: 2,
        assists: 8,
        result: "win",
        ratingBefore: 7180,
        ratingDelta: 25,
        ratingAfter: 7205,
        gameMode: "ranked",
        endedAt: minutesAgo(70),
    },
    {
        id: "preview-4",
        dotaMatchId: "8920415761",
        inventory: [],
        heroId: 8,
        kills: 9,
        deaths: 5,
        assists: 6,
        result: "win",
        ratingBefore: 7155,
        ratingDelta: 25,
        ratingAfter: 7180,
        gameMode: "ranked",
        endedAt: minutesAgo(105),
    },
    {
        id: "preview-5",
        dotaMatchId: "8920415760",
        inventory: [],
        heroId: 7,
        kills: 3,
        deaths: 8,
        assists: 12,
        result: "loss",
        ratingBefore: 7180,
        ratingDelta: -25,
        ratingAfter: 7155,
        gameMode: "ranked",
        endedAt: minutesAgo(140),
    },
    {
        id: "preview-6",
        dotaMatchId: "8920415759",
        inventory: [],
        heroId: 5,
        kills: 2,
        deaths: 3,
        assists: 24,
        result: "win",
        ratingBefore: 7155,
        ratingDelta: 25,
        ratingAfter: 7180,
        gameMode: "ranked",
        endedAt: minutesAgo(175),
    },
    {
        id: "preview-7",
        dotaMatchId: "8920415758",
        inventory: [],
        heroId: 13,
        kills: 7,
        deaths: 7,
        assists: 9,
        result: "loss",
        ratingBefore: 7180,
        ratingDelta: -25,
        ratingAfter: 7155,
        gameMode: "ranked",
        endedAt: minutesAgo(210),
    },
    {
        id: "preview-8",
        dotaMatchId: "8920415757",
        inventory: [],
        heroId: 2,
        kills: 15,
        deaths: 4,
        assists: 5,
        result: "win",
        ratingBefore: 7155,
        ratingDelta: 25,
        ratingAfter: 7180,
        gameMode: "ranked",
        endedAt: minutesAgo(245),
    },
];

// Текущая preview-session намеренно короче общей истории: Current stream
// не дополняется строками из прошлых sessions.
export const PREVIEW_CURRENT_STREAM_MATCHES = PREVIEW_MATCHES.slice(0, 5);
