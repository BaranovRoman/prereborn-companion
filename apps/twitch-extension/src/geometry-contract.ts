// WK-116 Phase 2 - shared geometry contract. Canonical shape lives in
// apps/api's quiz-round-service.ts (InteractiveRegion) and is enforced by
// controllers/stream/quiz.ts's publishGeometrySchema (PUT
// /stream/companion/quiz/geometry) - duplicated here rather than imported,
// same "ported from X" convention this repo already uses across the
// web/companion boundary (see e.g. companion's heroCatalog.ts).
//
// Two decisions this shape encodes, from the Phase 0 placement review:
//
// 1. Coordinates are normalized 0..1 against the FULL 16:9 broadcast video
//    canvas (the overlay's root/video-content element - `[data-testid=
//    "queue-scene"]` here, full-bleed with the OBS source), never against
//    the quiz board's own CSS box. The Twitch Extension has no visibility
//    into Companion's/this page's surrounding layout, only the final video
//    frame it overlays - a rect normalized against anything narrower would
//    be meaningless to it.
//
// 2. This page (like Companion) is a PRODUCER of geometry, not a consumer
//    of someone else's layout math: it measures its own real rendered
//    answer-button DOM rects (getBoundingClientRect) and reports the
//    result, rather than trying to derive positions analytically. The
//    Extension is the one true consumer - it reads published numbers, it
//    never re-implements this page's or Companion's CSS.
//
// `interactiveRegions` is a generic list (not a fixed 4-answer tuple) -
// v1 always renders exactly 4, but nothing in the type enforces that count,
// so a future interaction type (e.g. WK-156's "assemble the item" multi-
// select) reuses this same contract instead of a new one.

export interface QuizInteractiveRegion {
    id: string;
    // Normalized 0..1 against the full video canvas.
    x: number;
    y: number;
    width: number;
    height: number;
    // The option id this region activates - generic `value`, not
    // `optionId`, so a region that isn't 1:1 with a single answer option
    // isn't structurally precluded later.
    value: string;
}

// Matches PUT /stream/companion/quiz/geometry's actual accepted body
// exactly (controllers/stream/quiz.ts's publishGeometrySchema) - no
// separate `viewport` field: the aspect is implicitly always 16:9 for v1
// (nothing in this system varies it yet), so a field that could only ever
// hold one value isn't carried over the wire. Add one if/when that stops
// being true, not preemptively.
export interface QuizGeometryReport {
    roundId: string;
    interactiveRegions: QuizInteractiveRegion[];
}
