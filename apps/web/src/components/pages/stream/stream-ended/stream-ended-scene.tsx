"use client";

import { getHeroById } from "@/entities/dota-hero/lib/search";
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

// WK-98 - one chip per session match: hero portrait + win/loss mark + MMR
// delta. Deliberately a static <img>, not the looping PreloadedVideo used
// elsewhere in Between Matches (queue-scene-ui.tsx) - at this size, in a
// strip of up to ~20, a still icon reads clearly where autoplaying video
// would just be visual noise.
const MatchChip = ({ match }: { match: StreamMatch }) => {
    const hero = getHeroById(match.heroId);
    const result = match.result ?? "unknown";

    return (
        <div className={styles.matchChip} title={hero?.localizedName ?? `Hero ${match.heroId}`}>
            <span className={styles.matchChipPortrait} data-result={result}>
                {hero ? <img src={hero.imageUrl} alt="" /> : <span>?</span>}
                <i className={styles.matchChipMark} data-result={result} aria-hidden="true" />
            </span>
            <span className={styles.matchChipDelta} data-tone={deltaTone(match.ratingDelta)}>
                {match.ratingDelta === null ? EMPTY_VALUE : formatDelta(match.ratingDelta)}
            </span>
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
// session result. See get-active-scene.ts for why "ended" reaches this
// component at all (it wins over sceneOverride/GSI, unconditionally, once
// sessionState === "ended").
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

    const isRanked = summary.gameMode === "ranked";
    const hasRatingRange = summary.ratingStart !== null && summary.ratingEnd !== null;
    const recordTone =
        summary.wins === summary.losses ? undefined : summary.wins > summary.losses ? "positive" : "negative";

    const matches = data.matches ?? [];
    // WK-98 - `data.matches` is already this-session-only and bounded to 20
    // by the backend for the ended state (see ENDED_SESSION_MATCH_CAP in
    // controllers/stream/overlay.ts) - independent of recentGamesLimit/HUD
    // widget config. summary.matchCount (uncapped) stays the source of
    // truth, so a session longer than the cap gets an honest "+N" chip
    // instead of silently looking complete.
    const hiddenCount = Math.max(0, summary.matchCount - matches.length);
    // Newest-first from the backend (ORDER BY id DESC) - reversed so the
    // strip reads left-to-right as a chronological session timeline.
    const timeline = [...matches].reverse();

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

                {isRanked && (
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

                {timeline.length > 0 && (
                    <div className={styles.matchStrip} aria-label="Матчи сессии">
                        {hiddenCount > 0 && (
                            <span
                                data-testid="match-strip-more"
                                className={styles.matchStripMore}
                                title={`Ещё ${hiddenCount} матч(ей) вне отображаемого диапазона`}
                            >
                                +{hiddenCount}
                            </span>
                        )}
                        {timeline.map((match) => (
                            <MatchChip key={match.id} match={match} />
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
};
