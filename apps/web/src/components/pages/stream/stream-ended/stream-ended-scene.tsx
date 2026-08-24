"use client";

import type { CSSProperties } from "react";
import { getHeroById } from "@/entities/dota-hero/lib/search";
import { PreloadedVideo } from "@/components/pages/stream/queue/queue-scene-ui";
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

// WK-98 - four density tiers for the match-history grid, per the task's own
// guidance: 1-4 stays a single rich column, 5-8 moves to two, 9-14 to three,
// 15-20(+) to four - column count grows with match count so the grid keeps
// fitting the fixed 1920x1080 canvas without ever scrolling, and without
// degrading back into tiny square icons (hero art stays a landscape band at
// every tier, just a shorter one).
type HistoryDensity = "spacious" | "cozy" | "dense" | "compact";

const getHistoryDensity = (count: number): HistoryDensity => {
    if (count <= 4) return "spacious";
    if (count <= 8) return "cozy";
    if (count <= 14) return "dense";
    return "compact";
};

const DENSITY_COLUMNS: Record<HistoryDensity, number> = {
    spacious: 1,
    cozy: 2,
    dense: 3,
    compact: 4,
};

interface MatchEntryProps {
    match: StreamMatch;
    density: HistoryDensity;
}

// WK-98 - one match, one wide landscape band (hero.featuredVideoUrl/imageUrl
// - the exact asset already used for "Last Match" in Between Matches, see
// FeaturedMatch in queue-scene-ui.tsx) with a compact two-line caption below
// it: hero + result, then K/D/A + MMR delta. No inventory, no per-match
// duration/GPM/XPM/damage - StreamMatch doesn't carry any of that, and this
// entry is deliberately secondary to the W-L/MMR summary above it, not a
// stat sheet.
//
// Video autoplay is intentionally capped to the two least-dense tiers (up to
// 8 simultaneous entries) - at "dense"/"compact" (9-20 entries) this renders
// the same landscape artwork as a static poster frame instead. Nothing in
// the task asked for this distinction explicitly, but 20 simultaneously
// autoplaying WebM loops in an OBS Browser Source is a real perf/bandwidth
// risk to the actual broadcast - the poster is the exact first frame of the
// same asset, so the visual identity doesn't change, only the motion does.
const MatchEntry = ({ match, density }: MatchEntryProps) => {
    const hero = getHeroById(match.heroId);
    const result = match.result;
    const playsVideo = density === "spacious" || density === "cozy";

    return (
        <div
            className={styles.entry}
            data-result={result ?? "unknown"}
            title={hero?.localizedName ?? `Hero ${match.heroId}`}
        >
            <div className={styles.entryArt}>
                {hero ? (
                    playsVideo ? (
                        <PreloadedVideo
                            className={styles.entryArtMedia}
                            src={hero.featuredVideoUrl}
                            poster={hero.imageUrl}
                        />
                    ) : (
                        <img className={styles.entryArtMedia} src={hero.imageUrl} alt="" />
                    )
                ) : (
                    <span className={styles.entryArtUnknown}>?</span>
                )}
            </div>
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
        return <div className={styles.scene} data-testid="stream-ended-scene" />;
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

    const matches = data.matches ?? [];
    // WK-98 - `data.matches` is already this-session-only and bounded to 20
    // by the backend for the ended state (see ENDED_SESSION_MATCH_CAP in
    // controllers/stream/overlay.ts) - independent of recentGamesLimit/HUD
    // widget config. summary.matchCount (uncapped) stays the source of
    // truth, so a session longer than the cap gets an honest "+N" note
    // instead of silently looking complete.
    const hiddenCount = Math.max(0, summary.matchCount - matches.length);
    // Newest-first from the backend (ORDER BY id DESC) - reversed so the
    // history reads top-to-bottom/left-to-right as a chronological session
    // timeline, oldest match first.
    const timeline = [...matches].reverse();
    const density = getHistoryDensity(timeline.length);

    return (
        <div className={styles.scene} data-testid="stream-ended-scene">
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

            {timeline.length > 0 && (
                <div className={styles.history}>
                    <span className={styles.historyLabel}>История стрима</span>
                    <div
                        className={styles.historyGrid}
                        aria-label="История стрима"
                        data-density={density}
                        style={{ "--history-columns": DENSITY_COLUMNS[density] } as CSSProperties}
                    >
                        {timeline.map((match) => (
                            <MatchEntry key={match.id} match={match} density={density} />
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
            )}
        </div>
    );
};
