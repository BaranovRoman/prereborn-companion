// Phase 0 placement-spike content (WK-116) - a single realistic round, static
// for now. Real question banks/round state land in Phase 1/3; this only
// needs to look and measure like the real thing for the placement decision.
import type { QuizBoardLeaderboardEntry, QuizBoardOption } from "./QuizBoard";

export const MOCK_QUIZ_CATEGORY = "ПРЕДМЕТ";
export const MOCK_QUIZ_QUESTION = "Какой предмет усиливает регенерацию маны сильнее всего?";

export const MOCK_QUIZ_OPTIONS: QuizBoardOption[] = [
    { id: "a", label: "Arcane Boots" },
    { id: "b", label: "Power Treads" },
    { id: "c", label: "Aether Lens" },
    { id: "d", label: "Boots of Travel" },
];

export const MOCK_QUIZ_CORRECT_OPTION_ID = "a";

export const MOCK_QUIZ_DISTRIBUTION: Record<string, number> = {
    a: 54,
    b: 21,
    c: 17,
    d: 8,
};

export const MOCK_QUIZ_LEADERBOARD: QuizBoardLeaderboardEntry[] = [
    { rank: 1, displayName: "quiz_lover", score: 1400 },
    { rank: 2, displayName: "dota_fan_92", score: 1200 },
    { rank: 3, displayName: "mmr_watcher", score: 900 },
    { rank: 4, displayName: "regular_chatter", score: 800 },
    { rank: 5, displayName: "another_viewer", score: 600 },
];

export const MOCK_QUIZ_PHASE_DURATIONS = { question: 30, reveal: 10 } as const;
