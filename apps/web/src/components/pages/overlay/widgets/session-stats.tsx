import { AnimatePresence, motion } from "motion/react";
import type { StreamGameMode } from "@/entities/stream-session/model/types";
import styles from "./widget.module.scss";

interface SessionStatsProps {
    rating: number | null;
    // Суммарное изменение rating за сессию - null для unranked (там рейтинг
    // и так не показывается), 0 если ranked-матчей в сессии ещё не было.
    sessionRatingDelta: number | null;
    wins: number;
    losses: number;
    gameMode: StreamGameMode;
}

const FADE_TRANSITION = { duration: 0.2 };

const formatSessionDelta = (delta: number): string =>
    delta > 0 ? `+${delta}` : delta < 0 ? `${delta}` : "±0";

// Текущий рейтинг аккаунта и текущий режим матча - независимые вещи
// (см. задачу: "нерейтинговый матч не должен скрывать отображение
// рейтинга"). Unranked прячет только ИЗМЕНЕНИЕ рейтинга за эту сессию
// (sessionRatingDelta уже приходит null для unranked с бэкенда) и добавляет
// приглушённую пометку UNRANKED рядом с W/L - сам рейтинг показывается,
// пока он вообще известен, независимо от текущего режима.
export const SessionStats = ({
    rating,
    sessionRatingDelta,
    wins,
    losses,
    gameMode,
}: SessionStatsProps) => {
    const isRanked = gameMode === "ranked";
    return (
        <div className={styles.card}>
            {rating !== null && (
                <AnimatePresence mode="wait">
                    <motion.div
                        key={`${rating}-${sessionRatingDelta}`}
                        className={styles.rating}
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        transition={FADE_TRANSITION}
                    >
                        {rating} MMR
                        {sessionRatingDelta !== null && (
                            <span
                                className={
                                    sessionRatingDelta > 0
                                        ? styles.sessionDeltaPositive
                                        : sessionRatingDelta < 0
                                          ? styles.sessionDeltaNegative
                                          : styles.sessionDeltaNeutral
                                }
                            >
                                {" "}
                                ({formatSessionDelta(sessionRatingDelta)})
                            </span>
                        )}
                    </motion.div>
                </AnimatePresence>
            )}

            <AnimatePresence mode="wait">
                <motion.div
                    key={`${wins}-${losses}`}
                    className={styles.record}
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={FADE_TRANSITION}
                >
                    {wins}W / {losses}L
                    {!isRanked && (
                        <span className={styles.unrankedTag}> · UNRANKED</span>
                    )}
                </motion.div>
            </AnimatePresence>
        </div>
    );
};
