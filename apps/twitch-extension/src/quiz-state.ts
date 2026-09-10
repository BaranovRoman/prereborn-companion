// WK-116 Phase 4 - mirrors apps/api's quiz-round-service.ts QuizRoundState
// (the GET /stream/extension/quiz/state response shape) field-for-field,
// same duplication convention as apps/web/apps/companion's own copies.
import type { QuizInteractiveRegion } from "./geometry-contract";

export interface QuizOption {
    id: string;
    label: string;
    assetUrl: string | null;
}

export interface QuizRoundState {
    roundId: string;
    phase: "question" | "reveal";
    phaseEndsAt: string;
    category: string;
    interactionType: "single_choice_text";
    prompt: string;
    options: QuizOption[];
    correctOptionId: string | null;
    distribution: Record<string, number> | null;
    interactiveRegions: QuizInteractiveRegion[] | null;
    leaderboard: Array<{ rank: number; twitchViewerId: string; displayName: string; score: number; streak: number }>;
}
