import { computeHitboxDecision, isStateStale, POLL_INTERVAL_MS } from "./hitbox-logic";
import type { QuizRoundState } from "./quiz-state";

// WK-116 Phase 4 - Twitch Video Overlay Extension: a transparent
// interaction layer only. Renders no visible quiz UI of its own (no
// question text, no answer labels) - the visible board is Companion's
// (see BetweenMatchesScene.tsx). This page only ever draws invisible
// clickable regions positioned exactly over Companion's own rendered
// buttons, using geometry Companion measured and published - see
// hitbox-logic.ts's fail-closed guarantees for what happens when that
// geometry is missing, stale, or the round has moved past QUESTION.

// Twitch's Extension Helper script (loaded via <script> in index.html)
// defines this global - see
// https://dev.twitch.tv/docs/extensions/reference/#helper.
declare global {
    interface Window {
        Twitch: {
            ext: {
                onAuthorized: (
                    callback: (auth: { token: string; userId?: string; channelId: string; clientId: string }) => void
                ) => void;
                onContext?: (callback: (context: Record<string, unknown>) => void) => void;
                viewer?: { opaqueId?: string; id?: string; displayName?: string };
            };
        };
    }
}

// Local Developer Rig testing overrides the API base via a query param
// (the Rig lets you configure the panel URL's query string) - production
// Twitch never appends this, so the real deployed extension always uses
// the hardcoded default.
const params = new URLSearchParams(window.location.search);
const API_BASE = params.get("apiBase") ?? "https://prereborn.ru/api";
// Debug-only hitbox outlines (see the WK-116 correction's explicit
// allowance: "acceptable to temporarily render hitbox outlines in a
// dev/test mode to prove alignment. Production hitboxes should remain
// visually transparent").
const DEBUG_OUTLINES = params.get("debugHitboxes") === "1";

let authToken: string | null = null;
let lastFetchedAt: number | null = null;
let latestQuiz: QuizRoundState | null = null;
let answeredRoundId: string | null = null;
let submitting = false;

const root = document.createElement("div");
root.style.position = "fixed";
root.style.inset = "0";
root.style.pointerEvents = "none";
document.body.appendChild(root);

function renderHitboxes(): void {
    const decision = computeHitboxDecision({
        quiz: latestQuiz,
        lastFetchedAt,
        now: Date.now(),
        answeredRoundId,
    });

    root.replaceChildren();
    for (const region of decision.regions) {
        const box = document.createElement("button");
        box.type = "button";
        box.setAttribute("data-quiz-option-id", region.value);
        box.style.position = "absolute";
        box.style.left = `${region.x * 100}%`;
        box.style.top = `${region.y * 100}%`;
        box.style.width = `${region.width * 100}%`;
        box.style.height = `${region.height * 100}%`;
        box.style.border = "none";
        box.style.margin = "0";
        box.style.padding = "0";
        box.style.background = DEBUG_OUTLINES ? "rgba(123, 53, 50, 0.28)" : "transparent";
        box.style.outline = DEBUG_OUTLINES ? "2px solid rgba(184, 91, 83, 0.9)" : "none";
        box.style.pointerEvents = decision.interactive ? "auto" : "none";
        box.style.cursor = decision.interactive ? "pointer" : "default";
        box.disabled = !decision.interactive;
        box.setAttribute("aria-label", "Answer option");
        if (decision.interactive) {
            box.addEventListener("click", () => void submitAnswer(region.value));
        }
        root.appendChild(box);
    }
}

async function submitAnswer(optionId: string): Promise<void> {
    if (submitting || !authToken || !latestQuiz) return;
    // Re-check the decision synchronously at click time, not just when the
    // button was last rendered - a click event queued right as REVEAL hits
    // must not fire a submission the backend would reject anyway.
    const decision = computeHitboxDecision({ quiz: latestQuiz, lastFetchedAt, now: Date.now(), answeredRoundId });
    if (!decision.interactive) return;

    submitting = true;
    const roundId = latestQuiz.roundId;
    try {
        const response = await fetch(`${API_BASE}/stream/extension/quiz/answer`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${authToken}` },
            body: JSON.stringify({
                roundId,
                optionId,
                displayName: window.Twitch.ext.viewer?.displayName,
            }),
        });
        if (response.ok) {
            // Locally disable this round's hitboxes immediately - per the
            // correction, never wait for the next poll to reflect it.
            answeredRoundId = roundId;
            renderHitboxes();
        }
    } catch {
        // Network hiccup - the viewer can simply try again while QUESTION
        // is still active; no retry queue needed for a single click.
    } finally {
        submitting = false;
    }
}

async function pollQuizState(): Promise<void> {
    if (!authToken) return;
    try {
        const response = await fetch(`${API_BASE}/stream/extension/quiz/state`, {
            headers: { Authorization: `Bearer ${authToken}` },
        });
        if (response.ok) {
            const body = (await response.json()) as { quiz: QuizRoundState | null };
            latestQuiz = body.quiz;
            lastFetchedAt = Date.now();
        }
        // A non-ok response (401 on token refresh race, 503 not-configured,
        // 5xx) leaves latestQuiz/lastFetchedAt untouched - staleness
        // naturally fails the hitboxes closed once MAX_STATE_AGE_MS passes,
        // no separate error-handling path needed.
    } catch {
        // Network failure - same "let staleness handle it" reasoning.
    }
    renderHitboxes();
}

function start(): void {
    setInterval(() => void pollQuizState(), POLL_INTERVAL_MS);
    void pollQuizState();
}

window.Twitch.ext.onAuthorized((auth) => {
    authToken = auth.token;
    // A fresh authorization can mean a new/rotated token OR (rarely) a
    // genuinely different viewer session - resetting local answered-state
    // here would be wrong for a simple token refresh, so this deliberately
    // does NOT clear answeredRoundId; the backend's own per-round unique
    // answer constraint is the real source of truth regardless.
    start();
});

// Surface staleness in the DOM for the Developer Rig / manual QA to
// visually confirm fail-closed behavior without reading console logs.
if (DEBUG_OUTLINES) {
    setInterval(() => {
        document.title = isStateStale(lastFetchedAt, Date.now()) ? "quiz: stale/offline" : "quiz: live";
    }, 1000);
}
