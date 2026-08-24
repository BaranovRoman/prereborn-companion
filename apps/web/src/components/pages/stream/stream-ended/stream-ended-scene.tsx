"use client";

import { getHeroById } from "@/entities/dota-hero/lib/search";
import { QueueTreeLayers } from "@/components/pages/stream/queue/queue-tree-layers";
import type { OverlayData, StreamMatch } from "@/entities/stream-session/model/types";
import styles from "./stream-ended-scene.module.scss";

const EMPTY_VALUE = "—";

const formatRating = (rating: number | null) =>
    rating === null ? EMPTY_VALUE : new Intl.NumberFormat("en-US").format(rating);

const formatDelta = (delta: number | null) =>
    delta === null ? EMPTY_VALUE : delta === 0 ? "±0" : `${delta > 0 ? "+" : ""}${delta}`;

const deltaTone = (delta: number | null) =>
    delta === null || delta === 0 ? undefined : delta > 0 ? "positive" : "negative";

const formatDuration = (durationMs: number | null) => {
    if (durationMs === null || durationMs < 0) return EMPTY_VALUE;
    const totalMinutes = Math.round(durationMs / 60_000);
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    if (hours === 0) return `${minutes} мин`;
    return `${hours} ч ${minutes} мин`;
};

// Same vocabulary as FeaturedMatch/RecentGames (queue-scene-ui.tsx) -
// deliberately not re-exported/imported from there (this scene stays
// decoupled from Between Matches), just kept textually consistent.
const resultLabel = (result: StreamMatch["result"]) => {
    if (result === "win") return "VICTORY";
    if (result === "loss") return "DEFEAT";
    if (result === "abandon") return "ABANDON";
    return "UNKNOWN";
};

// WK-98 visual-refinement follow-up - the frontend renders at most this many
// history cards, even though the backend can return up to 20 (see
// ENDED_SESSION_MATCH_CAP in controllers/stream/overlay.ts, unchanged by
// this pass). Chosen after visual review: a handful of well-proportioned,
// clearly-readable 16:9 cards reads better as a broadcast recap than
// stretching to fit every one of a long session at a shrunken size. The
// newest N are shown (most recently relevant); summary.matchCount stays the
// honest uncapped total either way, with a plain-text "+N" note covering
// the gap - see StreamEndedScene below.
const VISIBLE_HISTORY_CAP = 16;

// WK-98 second visual-refinement pass - card size/composition now adapts to
// how many cards are actually rendered, while EVERY tier keeps the same
// 16:9 aspect ratio (see .entry in the stylesheet - only width changes per
// tier, never aspect-ratio). A single match stays a lone thumbnail-sized
// card if sized like a 9-16 match session; this reads as under-composed for
// what should feel like a featured final result. Boundaries chosen after
// screenshot comparison (see the WK-98 report), not a formula:
// - featured (1 match): one large, prominent card.
// - duo (2-4): larger cards, naturally wrapping into a compact 2-column
//   block (e.g. 2x2 for exactly 4) rather than one cramped row.
// - medium (5-8): mid-sized cards, 3 columns - gives 6 (the common case) an
//   even 3+3, and 8 an even 3+3+2, rather than a lonely trailing card.
// - compact (9-16): the size from the first pass of this composition,
//   4 columns - already reads well at this count.
type HistoryTier = "featured" | "duo" | "medium" | "compact";

const getHistoryTier = (count: number): HistoryTier => {
    if (count <= 1) return "featured";
    if (count <= 4) return "duo";
    if (count <= 8) return "medium";
    return "compact";
};

// WK-98 visual-refinement follow-up - hero.imageUrl (the same CDN asset
// already used everywhere else in this app, see hero-image.ts) is a native
// 256x144 PNG - exactly 16:9. Giving each card's art area a matching
// `aspect-ratio: 16/9` (see .entryArt in the stylesheet) means object-fit:
// cover barely has to crop it at all, unlike the previous pass's fixed
// short pixel heights on a stretchy-width container, which forced a ~5-10:1
// crop and left only a sliver of the source visible (an eye, a belly).
// Static poster only, deliberately no PreloadedVideo/autoplay here (see the
// task) - Between Matches' FeaturedMatch/FavoriteHeroes keep their video
// treatment untouched, this is a distinct, simpler composition.
const MatchEntry = ({ match }: { match: StreamMatch }) => {
    const hero = getHeroById(match.heroId);
    const result = match.result;

    return (
        <div
            className={styles.entry}
            data-result={result ?? "unknown"}
            title={hero?.localizedName ?? `Hero ${match.heroId}`}
        >
            <div className={styles.entryArt}>
                {hero ? (
                    <img className={styles.entryArtMedia} src={hero.imageUrl} alt="" />
                ) : (
                    <span className={styles.entryArtUnknown}>?</span>
                )}
                <span className={styles.entryScrim} aria-hidden="true" />
                <div className={styles.entryCaption}>
                    <div className={styles.entryCaptionRow}>
                        <b>{hero?.localizedName.toUpperCase() ?? `HERO ${match.heroId}`}</b>
                        <em data-result={result ?? "unknown"}>{resultLabel(result)}</em>
                    </div>
                    <div className={styles.entryCaptionRow}>
                        <span>{match.kills} / {match.deaths} / {match.assists}</span>
                        <span className={styles.entryDelta} data-tone={deltaTone(match.ratingDelta)}>
                            {match.ratingDelta === null ? EMPTY_VALUE : formatDelta(match.ratingDelta)}
                        </span>
                    </div>
                </div>
            </div>
        </div>
    );
};

interface StreamEndedSceneProps {
    data: OverlayData;
}

// WK-98 - the real post-stream final scene, replacing WK-53's
// StreamEndedBanner (a small ribbon that used to sit on top of an otherwise
// fully-live Between Matches dashboard - see queue-scene-ui.tsx history).
// This is a structurally separate composition: no Twitch chat, no webcam
// slot, no donors/followers/socials, no Favorite Heroes dashboard - just the
// session result plus a readable match-by-match history. See
// get-active-scene.ts for why "ended" reaches this component at all (it
// wins over sceneOverride/GSI, unconditionally, once sessionState ===
// "ended").
//
// Visual-refinement follow-up: summary and history are now a side-by-side
// composition (summary in its own left column, history filling the rest of
// the 1920x1080 canvas to the right) rather than stacked top-to-bottom -
// stacking was what forced the previous pass's history area into a short,
// wide strip. History cards are a fixed, sensible width and wrap via flex,
// so column count is a natural consequence of card width fitting the
// available space, not a hand-picked density tier per match count.
//
// Deliberately a pure function of `data` (OverlayData from the polled
// overlay endpoint, see use-overlay-polling.ts) - no local snapshot/useState
// of the summary or match list. The backend recomputes sessionSummary and
// `matches` live on every request (see stream-session-summary-service.ts),
// so a match that finalizes AFTER the streamer clicked "Завершить стрим"
// (see stream-match-service.ts's in-flight-match handling) is reflected
// automatically on the next ~1.5s poll, with no reload.
export const StreamEndedScene = ({ data }: StreamEndedSceneProps) => {
    const summary = data.sessionSummary;

    if (!summary) {
        // sessionState === "ended" implies a `latest` session exists server-
        // side (see controllers/stream/overlay.ts), so summary should always
        // be non-null here in practice - this is just a safe empty shell if
        // that contract is ever violated, not a real expected state.
        return (
            <div className={styles.scene} data-testid="stream-ended-scene">
                <QueueTreeLayers />
            </div>
        );
    }

    // Never render "— MMR": the block only exists when there's a real
    // ranked rating delta to show, not just because gameMode === "ranked".
    // A zero-match or never-rated ranked session has ratingDelta === null
    // (see getSessionSummary) and simply omits this section rather than
    // showing a dash that reads like a broken/missing value.
    const showMmr = summary.gameMode === "ranked" && summary.ratingDelta !== null;
    const hasRatingRange = summary.ratingStart !== null && summary.ratingEnd !== null;
    const recordTone =
        summary.wins === summary.losses ? undefined : summary.wins > summary.losses ? "positive" : "negative";

    // WK-98 - `data.matches` is already this-session-only, newest-first, and
    // bounded to 20 by the backend for the ended state (see
    // ENDED_SESSION_MATCH_CAP in controllers/stream/overlay.ts, unchanged
    // this pass) - independent of recentGamesLimit/HUD widget config. This
    // pass adds a stricter FRONTEND display cap (VISIBLE_HISTORY_CAP, see
    // above) purely for visual quality - keeps the newest matches (slice
    // before reversing), then reverses to a chronological oldest->newest
    // read. summary.matchCount (uncapped) stays the sole source of truth for
    // the true total either way, so a session longer than what's actually
    // rendered gets an honest "+N" note instead of silently looking
    // complete.
    const backendMatches = data.matches ?? [];
    const visibleMatches = backendMatches.slice(0, VISIBLE_HISTORY_CAP);
    const timeline = [...visibleMatches].reverse();
    const hiddenCount = Math.max(0, summary.matchCount - visibleMatches.length);
    const hasHistory = timeline.length > 0;
    const historyTier = getHistoryTier(timeline.length);

    return (
        <div className={styles.scene} data-testid="stream-ended-scene" data-has-history={hasHistory}>
            <QueueTreeLayers />
            <div className={styles.content}>
                <span className={styles.brand}>PREREBORN</span>
                <span className={styles.rule} aria-hidden="true" />
                <span className={styles.eyebrow}>Стрим завершён</span>

                <div className={styles.record} data-tone={recordTone}>
                    <span data-testid="record-wins">{summary.wins}</span>
                    <em>—</em>
                    <span data-testid="record-losses">{summary.losses}</span>
                </div>

                {showMmr && (
                    <div className={styles.mmr}>
                        <b data-testid="mmr-delta" data-tone={deltaTone(summary.ratingDelta)}>
                            {formatDelta(summary.ratingDelta)} MMR
                        </b>
                        {hasRatingRange && (
                            <small data-testid="mmr-range">
                                {formatRating(summary.ratingStart)} → {formatRating(summary.ratingEnd)}
                            </small>
                        )}
                    </div>
                )}

                <div className={styles.secondary}>
                    <div>
                        <b data-testid="match-count">{summary.matchCount}</b>
                        <span>Матчей</span>
                    </div>
                    <i aria-hidden="true" />
                    <div>
                        <b data-testid="duration">{formatDuration(summary.durationMs)}</b>
                        <span>Длительность</span>
                    </div>
                </div>
            </div>

            {hasHistory && (
                <>
                    <span className={styles.divider} aria-hidden="true" />
                    <div className={styles.history}>
                        <span className={styles.historyLabel}>История стрима</span>
                        <div className={styles.historyGrid} aria-label="История стрима" data-tier={historyTier}>
                            {timeline.map((match) => (
                                <MatchEntry key={match.id} match={match} />
                            ))}
                        </div>
                        {hiddenCount > 0 && (
                            <span
                                data-testid="match-strip-more"
                                className={styles.historyMore}
                                title={`Ещё ${hiddenCount} матч(ей) вне отображаемого диапазона`}
                            >
                                + ещё {hiddenCount} {hiddenCount === 1 ? "матч" : "матчей"}
                            </span>
                        )}
                    </div>
                </>
            )}
        </div>
    );
};
