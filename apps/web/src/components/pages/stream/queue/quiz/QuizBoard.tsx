import sceneStyles from "../queue-scene.module.scss";
import styles from "./quiz-board.module.scss";

export interface QuizBoardOption {
    id: string;
    label: string;
}

export interface QuizBoardLeaderboardEntry {
    rank: number;
    displayName: string;
    score: number;
}

export interface QuizBoardProps {
    title?: string;
    category: string;
    question: string;
    options: QuizBoardOption[];
    correctOptionId: string;
    // Percent (0-100) of viewers who picked each option - only meaningful
    // (and only rendered) during "reveal".
    distribution: Record<string, number>;
    leaderboard: QuizBoardLeaderboardEntry[];
    phase: "question" | "reveal";
    secondsLeft: number;
    // Phase 0 spike only - real duration comes from the backend round
    // (`phaseEndsAt`, see the WK-116 plan's Phase 1) once this is wired up.
    phaseDurationSeconds: number;
    // "vertical" - 2x2 answer grid, used by the tall dedicated-column and
    // rightMain-row variants. "horizontal" - single row of 4, used by the
    // compact top-strip variant, where height is the scarce dimension.
    layout: "vertical" | "horizontal";
}

export const QuizBoard = ({
    title = "QUIZ",
    category,
    question,
    options,
    correctOptionId,
    distribution,
    leaderboard,
    phase,
    secondsLeft,
    phaseDurationSeconds,
    layout,
}: QuizBoardProps) => {
    const progress = Math.max(0, Math.min(100, (secondsLeft / phaseDurationSeconds) * 100));
    return (
        <section className={`${sceneStyles.panel} ${styles.quizPanel}`} aria-label={title} data-quiz-root="">
            <div className={`${sceneStyles.panelTitle} ${styles.panelTitle}`}>
                <span>{title}</span>
                <span className={styles.phaseBadge} data-phase={phase}>
                    {phase === "question" ? category : "REVEAL"}
                </span>
            </div>
            <div className={styles.body} data-layout={layout}>
                <div className={styles.timerTrack}>
                    <i style={{ width: `${progress}%` }} data-phase={phase} />
                    <span>{String(secondsLeft).padStart(2, "0")}s</span>
                </div>
                <p className={styles.question}>{question}</p>
                <div className={styles.answers} data-layout={layout}>
                    {options.map((option, index) => {
                        const isCorrect = phase === "reveal" && option.id === correctOptionId;
                        const isWrong = phase === "reveal" && option.id !== correctOptionId;
                        const percent = distribution[option.id] ?? 0;
                        return (
                            <button
                                key={option.id}
                                type="button"
                                className={styles.answer}
                                data-quiz-answer={index}
                                data-quiz-option-id={option.id}
                                data-state={isCorrect ? "correct" : isWrong ? "wrong" : "idle"}
                                disabled
                            >
                                <span className={styles.answerLabel}>{option.label}</span>
                                {phase === "reveal" && (
                                    <>
                                        <span className={styles.answerPercent}>{percent}%</span>
                                        <i className={styles.answerBar} style={{ width: `${percent}%` }} />
                                    </>
                                )}
                            </button>
                        );
                    })}
                </div>
                {layout === "vertical" && (
                    <div className={styles.leaderboard}>
                        <span className={styles.leaderboardTitle}>TOP 5</span>
                        <ol>
                            {leaderboard.map((entry) => (
                                <li key={entry.rank}>
                                    <span className={styles.leaderboardRank}>{entry.rank}</span>
                                    <span className={styles.leaderboardName}>{entry.displayName}</span>
                                    <span className={styles.leaderboardScore}>{entry.score}</span>
                                </li>
                            ))}
                        </ol>
                    </div>
                )}
            </div>
        </section>
    );
};
