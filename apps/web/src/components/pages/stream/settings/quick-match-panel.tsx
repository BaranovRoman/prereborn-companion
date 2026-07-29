"use client";

import { useEffect, useState } from "react";
import { Button, InputNumber, Segmented, message } from "antd";
import { streamMatchesApi } from "@/entities/stream-session/api/stream-matches";
import { getHeroById } from "@/entities/dota-hero/lib/search";
import type {
    AccountStreamMatch,
    MatchCorrectionCommand,
    MatchResult,
} from "@/entities/stream-session/model/types";
import sharedStyles from "./index.module.scss";
import styles from "./quick-match-panel.module.scss";

const RESULT_OPTIONS = [
    { label: "Победа", value: "win" as const },
    { label: "Поражение", value: "loss" as const },
    { label: "Abandon", value: "abandon" as const },
];

const RESULT_LABEL: Record<MatchResult, string> = {
    win: "Победа",
    loss: "Поражение",
    abandon: "Abandon",
};

const RESULT_BADGE_CLASS: Record<MatchResult, string> = {
    win: styles.badgeWin,
    loss: styles.badgeLoss,
    abandon: styles.badgeAbandon,
};

const DELTA_STEP = 25;

interface QuickMatchPanelProps {
    match: AccountStreamMatch;
    onUpdated: (updated: AccountStreamMatch) => void;
}

// Основной десктоп/мобильный сценарий (см. задачу: карточка "Последний
// матч") - закрытое состояние показывает готовый исход компактно, форма
// правки (Победа/Поражение/Abandon, рейтинг, изменение, сохранить)
// раскрывается только по "Исправить" или автоматически для needs_review -
// сама правка (PATCH .../matches/:id) не изменилась, изменилось только то,
// когда форма видна.
export const QuickMatchPanel = ({ match, onUpdated }: QuickMatchPanelProps) => {
    const hero = getHeroById(match.heroId);
    const heroTitle = hero?.localizedName ?? `Hero ${match.heroId}`;
    const needsReview = match.state === "needs_review";
    const ratingBefore = match.ratingBefore;

    const [result, setResult] = useState<typeof match.result>(match.result);
    const [isRanked, setIsRanked] = useState(match.isRanked === true);
    const [ratingDelta, setRatingDelta] = useState<number | null>(match.ratingDelta);
    const [ratingAfter, setRatingAfter] = useState<number | null>(match.ratingAfter);
    const [expanded, setExpanded] = useState(needsReview);
    const [saving, setSaving] = useState(false);
    const [discarding, setDiscarding] = useState(false);
    const [justSaved, setJustSaved] = useState(false);
    const [messageApi, contextHolder] = message.useMessage();

    // Синхронизируем драфт только когда сменился САМ матч (например,
    // стример доиграл следующий, и "последним" стал уже другой) - не на
    // каждый ре-рендер родителя, иначе неотправленная правка терялась бы.
    useEffect(() => {
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setResult(match.result);
        setIsRanked(match.isRanked === true);
        setRatingDelta(match.ratingDelta);
        setRatingAfter(match.ratingAfter);
        setJustSaved(false);
        setExpanded(match.state === "needs_review");
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [match.id]);

    const isOpen = expanded || needsReview;
    const dirty =
        result !== match.result ||
        isRanked !== (match.isRanked === true) ||
        ratingDelta !== match.ratingDelta ||
        ratingAfter !== match.ratingAfter;

    const handleRatingAfterChange = (value: number | null) => {
        setJustSaved(false);
        setRatingAfter(value);
        setRatingDelta(
            value !== null && ratingBefore !== null ? value - ratingBefore : null
        );
    };

    // ratingBefore неизвестен только для самого первого отслеженного матча
    // (нет предыдущей точки отсчёта) - в этом случае поле "Изменение"
    // заблокировано в разметке ниже, а не пересчитывается отсюда.
    const handleDeltaChange = (value: number | null) => {
        setJustSaved(false);
        if (value === null) {
            setRatingDelta(null);
            setRatingAfter(null);
            return;
        }
        setRatingDelta(value);
        if (ratingBefore !== null) setRatingAfter(ratingBefore + value);
    };

    const adjustRating = (step: number) => {
        if (ratingBefore === null) {
            setJustSaved(false);
            setRatingDelta((current) => (current ?? 0) + step);
            return;
        }
        handleDeltaChange((ratingDelta ?? 0) + step);
    };

    const handleSave = async () => {
        const command: MatchCorrectionCommand = {};
        if (result !== null && result !== match.result) command.result = result;
        if (isRanked !== (match.isRanked === true)) command.isRanked = isRanked;
        // ABANDON всегда -25 на backend (см. correctStreamMatch) - ручная
        // дельта для него запрещена (backend отклоняет команду с обоими
        // полями), поэтому ratingAfter из локального превью сюда не
        // попадает, даже если пользователь до этого правил "Текущий рейтинг".
        if (
            isRanked &&
            result !== "abandon" &&
            ratingDelta !== null &&
            ratingDelta !== match.ratingDelta
        ) {
            command.ratingDelta = ratingDelta;
        } else if (
            isRanked &&
            result !== "abandon" &&
            ratingAfter !== null &&
            ratingAfter !== match.ratingAfter
        ) {
            command.ratingAfter = ratingAfter;
        }
        if (Object.keys(command).length === 0) return;

        setSaving(true);
        try {
            const response = await streamMatchesApi.patch(match.id, command);
            setIsRanked(response.match.isRanked === true);
            setRatingDelta(response.match.ratingDelta);
            setRatingAfter(response.match.ratingAfter);
            onUpdated(response.match);
            setJustSaved(true);
            messageApi.success("Матч обновлён");
        } catch {
            // Драфт (result/ratingAfter) намеренно не сбрасывается - см.
            // задачу "при ошибке введённые данные не теряются".
            messageApi.error("Не удалось сохранить, попробуйте ещё раз");
        } finally {
            setSaving(false);
        }
    };

    // "Не учитывать" - только для спорного матча (needs_review), которому
    // GSI не смог уверенно определить результат/тип - см. задачу. Матч
    // остаётся в истории, но W/L и рейтинг не трогаются.
    const handleDiscard = async () => {
        setDiscarding(true);
        try {
            const response = await streamMatchesApi.patch(match.id, { discard: true });
            onUpdated(response.match);
            messageApi.success("Матч не учитывается в W/L и рейтинге");
        } catch {
            messageApi.error("Не удалось сохранить, попробуйте ещё раз");
        } finally {
            setDiscarding(false);
        }
    };

    return (
        <div className={sharedStyles.section}>
            {contextHolder}
            <div className={styles.headerRow}>
                <h2 className={sharedStyles.sectionTitle}>Последний матч</h2>
                {!needsReview && (
                    <Button
                        type="link"
                        size="small"
                        className={styles.toggleButton}
                        onClick={() => setExpanded((value) => !value)}
                    >
                        {isOpen ? "Свернуть" : "Исправить"}
                    </Button>
                )}
            </div>

            {needsReview && (
                <div className={styles.needsReviewBanner}>
                    Требует проверки — GSI не смог уверенно определить исход
                </div>
            )}

            <div className={styles.summary}>
                <img
                    src={hero?.imageUrl}
                    alt={heroTitle}
                    title={heroTitle}
                    aria-label={heroTitle}
                    className={styles.heroIcon}
                    onError={(event) => {
                        event.currentTarget.style.visibility = "hidden";
                    }}
                />
                <div className={styles.summaryInfo}>
                    <span className={styles.kda}>
                        {match.kills} / {match.deaths} / {match.assists}
                    </span>
                    {result ? (
                        <span className={RESULT_BADGE_CLASS[result]}>
                            {RESULT_LABEL[result]}
                        </span>
                    ) : (
                        <span className={styles.badgeUnknown}>—</span>
                    )}
                    {!isRanked && <span className={styles.note}>unranked</span>}
                </div>
                {isRanked && (
                    <div className={styles.summaryRating}>
                        {ratingDelta !== null && (
                            <span
                                className={
                                    ratingDelta >= 0 ? styles.deltaPositive : styles.deltaNegative
                                }
                            >
                                {ratingDelta > 0 ? "+" : ""}
                                {ratingDelta}
                            </span>
                        )}
                        <span className={styles.ratingAfterValue}>
                            {ratingAfter ?? "—"}
                        </span>
                    </div>
                )}
            </div>

            {isOpen && (
                <>
                    <div className={styles.form}>
                        <Segmented
                            block
                            size="large"
                            value={result ?? undefined}
                            options={RESULT_OPTIONS}
                            disabled={saving}
                            onChange={(value) => {
                                setJustSaved(false);
                                setResult(value);
                                // ABANDON всегда ровно -25 (см. задачу) - превью
                                // пересчитывается сразу при выборе, а не только после
                                // сохранения, чтобы поля "Текущий рейтинг"/"Изменение"
                                // не показывали устаревшее win/loss-значение. При
                                // уходе с abandon обратно на win/loss возвращаем
                                // дефолтное +25/-25 превью того же вида, что и backend
                                // применил бы сам (см. correctStreamMatch).
                                if (ratingBefore !== null) {
                                    setRatingAfter(
                                        ratingBefore + (value === "win" ? DELTA_STEP : -DELTA_STEP)
                                    );
                                }
                            }}
                        />

                        <span className={styles.formLabel}>Режим матча</span>
                        <Segmented
                            block
                            value={isRanked ? "ranked" : "unranked"}
                            options={[
                                { label: "Рейтинговый", value: "ranked" },
                                { label: "Обычный", value: "unranked" },
                            ]}
                            disabled={saving}
                            onChange={(value) => {
                                setJustSaved(false);
                                const ranked = value === "ranked";
                                setIsRanked(ranked);
                                if (!ranked) {
                                    setRatingDelta(null);
                                    setRatingAfter(null);
                                }
                            }}
                        />

                        {isRanked && (
                            <>
                                <span className={styles.formLabel}>Текущий рейтинг</span>
                                <InputNumber
                                    className={styles.ratingInput}
                                    size="large"
                                    min={1}
                                    precision={0}
                                    value={ratingAfter}
                                    disabled={saving || result === "abandon"}
                                    onChange={handleRatingAfterChange}
                                />

                                <span className={styles.formLabel}>Изменение</span>
                                <div className={styles.ratingRow}>
                                    <InputNumber
                                        className={styles.ratingInput}
                                        size="large"
                                        precision={0}
                                        value={ratingDelta}
                                        disabled={saving || result === "abandon"}
                                        formatter={(value) =>
                                            value === undefined || value === null
                                                ? ""
                                                : `${Number(value) > 0 ? "+" : ""}${value}`
                                        }
                                        parser={(displayValue) => {
                                            if (!displayValue) return 0;
                                            const parsed = Number(displayValue.replace(/^\+/, ""));
                                            return Number.isNaN(parsed) ? 0 : parsed;
                                        }}
                                        onChange={handleDeltaChange}
                                    />
                                    <div className={styles.deltaButtons}>
                                        <Button
                                            size="large"
                                            disabled={saving || result === "abandon"}
                                            onClick={() => adjustRating(-DELTA_STEP)}
                                        >
                                            −{DELTA_STEP}
                                        </Button>
                                        <Button
                                            size="large"
                                            disabled={saving || result === "abandon"}
                                            onClick={() => adjustRating(DELTA_STEP)}
                                        >
                                            +{DELTA_STEP}
                                        </Button>
                                    </div>
                                </div>
                                {ratingBefore === null && (
                                    <div className={styles.deltaPreview}>
                                        Можно указать signed delta; рейтинг до матча восстановит сервер
                                    </div>
                                )}
                                {result === "abandon" && ratingBefore !== null && (
                                    <div className={styles.deltaPreview}>
                                        Abandon — рейтинг всегда −{DELTA_STEP}
                                    </div>
                                )}
                            </>
                        )}
                        {!isRanked && (
                            <div className={styles.deltaPreview}>
                                Рейтинг за этот матч не изменяется
                            </div>
                        )}
                    </div>

                    <Button
                        type="primary"
                        size="large"
                        block
                        className={styles.saveButton}
                        loading={saving}
                        disabled={!dirty}
                        onClick={handleSave}
                    >
                        {!dirty && justSaved ? "Сохранено ✓" : "Сохранить"}
                    </Button>

                    {needsReview && (
                        <Button
                            size="large"
                            block
                            className={styles.saveButton}
                            loading={discarding}
                            onClick={handleDiscard}
                        >
                            Не учитывать
                        </Button>
                    )}
                </>
            )}
        </div>
    );
};
