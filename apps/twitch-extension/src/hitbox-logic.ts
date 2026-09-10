import type { QuizInteractiveRegion } from "./geometry-contract";
import type { QuizRoundState } from "./quiz-state";

// WK-116 Phase 4 - the Extension's core decision: given the latest polled
// quiz state (or lack of it) and this viewer's own local "already
// answered" record, should hitboxes be rendered, and are they clickable?
// Deliberately pure/framework-free so the fail-closed guarantees below are
// directly unit-testable without a DOM or a real Twitch Helper - main.ts is
// just wiring this to polling/click events.
//
// Fail-closed, per the locked architecture: absent, stale, or mismatched
// geometry never falls back to a guessed position - it renders nothing
// interactive. "Stale" matters because Companion is the sole geometry
// producer (this Extension has no path to Companion directly) - if
// Companion goes offline mid-stream, this Extension must not keep showing
// hitboxes at their last-known position indefinitely; MAX_STATE_AGE_MS
// bounds how long a poll response is still trusted.
export const MAX_STATE_AGE_MS = 8_000; // ~4 missed polls at the 2s cadence below
export const POLL_INTERVAL_MS = 2_000;

export interface HitboxDecision {
    // Regions to render as transparent overlays (empty when there's nothing
    // to show at all - no stale/guessed geometry ever appears here).
    regions: QuizInteractiveRegion[];
    // Whether those regions should actually accept clicks right now -
    // rendering an inactive region (e.g. during reveal, or after this
    // viewer already answered) can still be useful for a subtle local
    // selected/disabled visual, per the correction's allowance for minimal
    // viewer-local feedback, but it must never submit another answer.
    interactive: boolean;
    roundId: string | null;
}

const EMPTY: HitboxDecision = { regions: [], interactive: false, roundId: null };

export function computeHitboxDecision(params: {
    quiz: QuizRoundState | null;
    lastFetchedAt: number | null;
    now: number;
    answeredRoundId: string | null;
}): HitboxDecision {
    const { quiz, lastFetchedAt, now, answeredRoundId } = params;

    // Fail closed: no successful poll yet, or the quiz itself is null (no
    // active round - e.g. not in Between Matches, or the channel isn't
    // linked at all).
    if (!quiz || lastFetchedAt === null) return EMPTY;

    // Fail closed: the last successful poll is too old to trust - Companion
    // may be offline, or this viewer's connection may have degraded. Never
    // keep showing hitboxes at a position that might no longer match what's
    // on screen.
    if (now - lastFetchedAt > MAX_STATE_AGE_MS) return EMPTY;

    // Fail closed: Companion hasn't published geometry for this round yet
    // (or ever) - there is nothing here to guess a position from.
    if (!quiz.interactiveRegions || quiz.interactiveRegions.length === 0) return EMPTY;

    // REVEAL - hitboxes render (so a "you answered this" local highlight
    // can still work, per the correction's minimal-local-feedback
    // allowance) but are never interactive.
    if (quiz.phase === "reveal") {
        return { regions: quiz.interactiveRegions, interactive: false, roundId: quiz.roundId };
    }

    // QUESTION, but this viewer already answered THIS round - disable
    // locally rather than let a second click attempt a submission the
    // backend would reject anyway (already_answered) - see the correction:
    // "after viewer answer, their hitboxes become locally disabled".
    if (answeredRoundId === quiz.roundId) {
        return { regions: quiz.interactiveRegions, interactive: false, roundId: quiz.roundId };
    }

    return { regions: quiz.interactiveRegions, interactive: true, roundId: quiz.roundId };
}

export function isStateStale(lastFetchedAt: number | null, now: number): boolean {
    return lastFetchedAt === null || now - lastFetchedAt > MAX_STATE_AGE_MS;
}
