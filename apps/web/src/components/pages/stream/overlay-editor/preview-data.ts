import type {
    OverlayCompanionState,
    StreamMatch,
} from "@/entities/stream-session/model/types";

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

export const PREVIEW_COMPANION: OverlayCompanionState = {
    isOnline: true,
    receivedAt: new Date().toISOString(),
    companionVersion: "preview",
    payload: null,
};
