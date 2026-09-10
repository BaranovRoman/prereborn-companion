import { describe, it, expect } from "vitest";
import { computeHitboxDecision, isStateStale, MAX_STATE_AGE_MS } from "./hitbox-logic";
import type { QuizRoundState } from "./quiz-state";

const REGIONS = [
    { id: "0", x: 0.1, y: 0.8, width: 0.2, height: 0.05, value: "opt-a" },
    { id: "1", x: 0.35, y: 0.8, width: 0.2, height: 0.05, value: "opt-b" },
];

const baseQuiz = (overrides: Partial<QuizRoundState> = {}): QuizRoundState => ({
    roundId: "round-1",
    phase: "question",
    phaseEndsAt: new Date().toISOString(),
    category: "ПРЕДМЕТ",
    interactionType: "single_choice_text",
    prompt: "test question",
    options: [
        { id: "opt-a", label: "A", assetUrl: null },
        { id: "opt-b", label: "B", assetUrl: null },
    ],
    correctOptionId: null,
    distribution: null,
    interactiveRegions: REGIONS,
    leaderboard: [],
    ...overrides,
});

describe("computeHitboxDecision - fail-closed guarantees", () => {
    it("renders nothing when there is no quiz at all", () => {
        const decision = computeHitboxDecision({ quiz: null, lastFetchedAt: Date.now(), now: Date.now(), answeredRoundId: null });
        expect(decision).toEqual({ regions: [], interactive: false, roundId: null });
    });

    it("renders nothing before the first successful poll (lastFetchedAt null)", () => {
        const decision = computeHitboxDecision({ quiz: baseQuiz(), lastFetchedAt: null, now: Date.now(), answeredRoundId: null });
        expect(decision.regions).toHaveLength(0);
        expect(decision.interactive).toBe(false);
    });

    it("renders nothing once the last successful poll is stale (Companion presumed offline)", () => {
        const now = Date.now();
        const decision = computeHitboxDecision({
            quiz: baseQuiz(),
            lastFetchedAt: now - MAX_STATE_AGE_MS - 1,
            now,
            answeredRoundId: null,
        });
        expect(decision).toEqual({ regions: [], interactive: false, roundId: null });
    });

    it("stays active right up to the staleness boundary", () => {
        const now = Date.now();
        const decision = computeHitboxDecision({
            quiz: baseQuiz(),
            lastFetchedAt: now - MAX_STATE_AGE_MS + 1,
            now,
            answeredRoundId: null,
        });
        expect(decision.interactive).toBe(true);
    });

    it("renders nothing when Companion has never published geometry for this round", () => {
        const now = Date.now();
        const decision = computeHitboxDecision({
            quiz: baseQuiz({ interactiveRegions: null }),
            lastFetchedAt: now,
            now,
            answeredRoundId: null,
        });
        expect(decision).toEqual({ regions: [], interactive: false, roundId: null });
    });

    it("renders nothing when the published region list is empty", () => {
        const now = Date.now();
        const decision = computeHitboxDecision({
            quiz: baseQuiz({ interactiveRegions: [] }),
            lastFetchedAt: now,
            now,
            answeredRoundId: null,
        });
        expect(decision.regions).toHaveLength(0);
    });
});

describe("computeHitboxDecision - phase gating", () => {
    it("is interactive during QUESTION for a viewer who hasn't answered yet", () => {
        const now = Date.now();
        const decision = computeHitboxDecision({ quiz: baseQuiz({ phase: "question" }), lastFetchedAt: now, now, answeredRoundId: null });
        expect(decision.interactive).toBe(true);
        expect(decision.regions).toEqual(REGIONS);
    });

    it("renders regions but is NOT interactive during REVEAL", () => {
        const now = Date.now();
        const decision = computeHitboxDecision({ quiz: baseQuiz({ phase: "reveal" }), lastFetchedAt: now, now, answeredRoundId: null });
        expect(decision.interactive).toBe(false);
        expect(decision.regions).toEqual(REGIONS);
    });

    it("disables locally once this viewer has already answered the current round", () => {
        const now = Date.now();
        const decision = computeHitboxDecision({
            quiz: baseQuiz({ phase: "question", roundId: "round-1" }),
            lastFetchedAt: now,
            now,
            answeredRoundId: "round-1",
        });
        expect(decision.interactive).toBe(false);
        expect(decision.regions).toEqual(REGIONS);
    });

    it("re-enables for a NEW round even if the viewer answered a previous one", () => {
        const now = Date.now();
        const decision = computeHitboxDecision({
            quiz: baseQuiz({ phase: "question", roundId: "round-2" }),
            lastFetchedAt: now,
            now,
            answeredRoundId: "round-1",
        });
        expect(decision.interactive).toBe(true);
    });
});

describe("isStateStale", () => {
    it("is stale when nothing has ever been fetched", () => {
        expect(isStateStale(null, Date.now())).toBe(true);
    });

    it("is not stale immediately after a fetch", () => {
        const now = Date.now();
        expect(isStateStale(now, now)).toBe(false);
    });

    it("becomes stale past MAX_STATE_AGE_MS", () => {
        const now = Date.now();
        expect(isStateStale(now - MAX_STATE_AGE_MS - 1, now)).toBe(true);
    });
});
