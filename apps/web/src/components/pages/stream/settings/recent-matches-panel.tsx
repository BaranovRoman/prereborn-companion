"use client";

import { useState } from "react";
import { Button, Collapse, InputNumber, Segmented, Select, message } from "antd";
import type { CollapseProps } from "antd";
import type { MessageInstance } from "antd/es/message/interface";
import { streamMatchesApi } from "@/entities/stream-session/api/stream-matches";
import { isMatchFromCurrentSession } from "@/entities/stream-session/lib/is-match-from-current-session";
import { getHeroById } from "@/entities/dota-hero/lib/search";
import type {
    AccountStreamMatch,
    MatchCorrectionCommand,
    MatchResult,
    StreamMatch,
} from "@/entities/stream-session/model/types";
import sharedStyles from "./index.module.scss";
import styles from "./recent-matches-panel.module.scss";

type RatingEditMode = "delta" | "after" | null;

interface MatchRowProps {
    match: AccountStreamMatch;
    isCurrentSession: boolean;
    onUpdated: (updated: AccountStreamMatch) => void;
    messageApi: MessageInstance;
}

// Result и ratingDelta/ratingAfter - независимые контролы, но ratingDelta и
// ratingAfter взаимоисключающие в UI (см. задачу, п.4: Вариант A - дельта,
// Вариант B - итоговый рейтинг) - editMode блокирует второе поле, пока
// редактируется первое, зеркаля backend'ный .refine(), который отклоняет
// одновременную передачу обоих.
const MatchRow = ({ match, isCurrentSession, onUpdated, messageApi }: MatchRowProps) => {
    const hero = getHeroById(match.heroId);
    const needsReview = match.state === "needs_review";
    const [isRanked, setIsRanked] = useState(match.isRanked === true);
    const [result, setResult] = useState<MatchResult | null>(match.result);
    const [ratingDelta, setRatingDelta] = useState<number | null>(match.ratingDelta);
    const [ratingAfter, setRatingAfter] = useState<number | null>(match.ratingAfter);
    const [editMode, setEditMode] = useState<RatingEditMode>(null);
    const [saving, setSaving] = useState(false);

    const applyResponse = (updated: AccountStreamMatch) => {
        setResult(updated.result);
        setIsRanked(updated.isRanked === true);
        setRatingDelta(updated.ratingDelta);
        setRatingAfter(updated.ratingAfter);
        onUpdated(updated);
    };

    const save = async (command: MatchCorrectionCommand) => {
        setSaving(true);
        try {
            const response = await streamMatchesApi.patch(match.id, command);
            applyResponse(response.match);
        } catch {
            messageApi.error("Не удалось сохранить матч");
            setIsRanked(match.isRanked === true);
            setResult(match.result);
            setRatingDelta(match.ratingDelta);
            setRatingAfter(match.ratingAfter);
        } finally {
            setSaving(false);
            setEditMode(null);
        }
    };

    const handleResultChange = (value: MatchResult) => {
        setResult(value);
        // ABANDON рейтинг всегда -25, вычисляется на backend
        // (correctStreamMatch) - сюда намеренно не подмешиваются
        // ratingDelta/ratingAfter, иначе backend отклонит команду
        // (AbandonRatingEditError).
        void save({ result: value });
    };

    const handleDeltaBlur = () => {
        if (
            ratingDelta === null ||
            (ratingDelta === match.ratingDelta && isRanked === (match.isRanked === true))
        ) {
            setEditMode(null);
            return;
        }
        void save({
            ratingDelta,
            ...(isRanked !== (match.isRanked === true) ? { isRanked } : {}),
        });
    };

    const handleAfterBlur = () => {
        if (ratingAfter === null || ratingAfter === match.ratingAfter) {
            setEditMode(null);
            return;
        }
        void save({
            ratingAfter,
            ...(isRanked !== (match.isRanked === true) ? { isRanked } : {}),
        });
    };

    // "Не учитывать" - см. QuickMatchPanel/задачу: доступно только для
    // спорного (needs_review) матча, не меняет W/L и рейтинг.
    const handleDiscard = async () => {
        setSaving(true);
        try {
            const response = await streamMatchesApi.patch(match.id, { discard: true });
            applyResponse(response.match);
            messageApi.success("Матч не учитывается в W/L и рейтинге");
        } catch {
            messageApi.error("Не удалось сохранить матч");
        } finally {
            setSaving(false);
        }
    };

    return (
        <div
            className={
                isCurrentSession ? styles.row : `${styles.row} ${styles.rowPreviousSession}`
            }
            data-session={isCurrentSession ? "current" : "previous"}
        >
            <img
                src={hero?.imageUrl}
                alt=""
                title={hero?.localizedName ?? `Hero ${match.heroId}`}
                className={styles.heroIcon}
                onError={(event) => {
                    event.currentTarget.style.visibility = "hidden";
                }}
            />
            <span className={styles.kda}>
                {match.kills}/{match.deaths}/{match.assists}
            </span>
            {needsReview && <span className={styles.note}>требует проверки</span>}
            <Select<MatchResult>
                className={styles.resultSelect}
                size="small"
                value={result ?? undefined}
                placeholder="—"
                disabled={saving}
                onChange={handleResultChange}
                options={[
                    { value: "win", label: "Победа" },
                    { value: "loss", label: "Поражение" },
                    { value: "abandon", label: "Abandon", className: styles.resultOptionAbandon },
                ]}
            />
            <Segmented
                size="small"
                value={isRanked ? "ranked" : "unranked"}
                options={[
                    { label: "Рейтинговый", value: "ranked" },
                    { label: "Обычный", value: "unranked" },
                ]}
                disabled={saving}
                onChange={(value) => {
                    const ranked = value === "ranked";
                    setIsRanked(ranked);
                    if (!ranked) {
                        setRatingDelta(null);
                        setRatingAfter(null);
                        void save({ isRanked: false });
                    }
                }}
            />
            {needsReview && (
                <Button size="small" disabled={saving} onClick={() => void handleDiscard()}>
                    Не учитывать
                </Button>
            )}
            {isRanked && (
                <>
                    <InputNumber
                        className={styles.ratingInput}
                        size="small"
                        placeholder="Δ рейтинга"
                        value={ratingDelta}
                        disabled={saving || editMode === "after" || result === "abandon"}
                        onFocus={() => setEditMode("delta")}
                        onChange={(value) => setRatingDelta(value)}
                        onBlur={handleDeltaBlur}
                    />
                    <InputNumber
                        className={styles.ratingInput}
                        size="small"
                        placeholder="Рейтинг после"
                        min={1}
                        value={ratingAfter}
                        disabled={saving || editMode === "delta" || result === "abandon"}
                        onFocus={() => setEditMode("after")}
                        onChange={(value) => setRatingAfter(value)}
                        onBlur={handleAfterBlur}
                    />
                </>
            )}
            {!isRanked && (
                <span className={styles.note}>
                    Рейтинг за этот матч не изменяется
                </span>
            )}
            {!match.streamSessionId && (
                <span className={styles.note}>
                    не привязан к сессии — W/L и рейтинг не пересчитываются
                </span>
            )}
        </div>
    );
};

const RESULT_LABEL: Record<MatchResult, string> = {
    win: "W",
    loss: "L",
    abandon: "A",
};

const RESULT_CLASS: Record<MatchResult, string> = {
    win: styles.compactResultWin,
    loss: styles.compactResultLoss,
    abandon: styles.compactResultAbandon,
};

const CompactMatchRow = ({ match }: { match: StreamMatch }) => {
    const hero = getHeroById(match.heroId);
    const heroTitle = hero?.localizedName ?? `Hero ${match.heroId}`;
    const isRanked = match.gameMode === "ranked";

    return (
        <div className={styles.compactRow}>
            <img
                src={hero?.imageUrl}
                alt={heroTitle}
                title={heroTitle}
                className={styles.compactHeroIcon}
                onError={(event) => {
                    event.currentTarget.style.visibility = "hidden";
                }}
            />
            {match.result && (
                <span className={RESULT_CLASS[match.result]}>
                    {RESULT_LABEL[match.result]}
                </span>
            )}
            <span className={styles.compactKda}>
                {match.kills}/{match.deaths}/{match.assists}
            </span>
            {isRanked && match.ratingDelta !== null && (
                <span
                    className={
                        match.ratingDelta >= 0
                            ? styles.compactDeltaPositive
                            : styles.compactDeltaNegative
                    }
                >
                    {match.ratingDelta > 0 ? "+" : ""}
                    {match.ratingDelta}
                </span>
            )}
            {isRanked && (
                <span className={styles.compactRatingAfter}>
                    {match.ratingAfter ?? "—"}
                </span>
            )}
        </div>
    );
};

interface RecentMatchesPanelProps {
    // Компактный превью-список - тот же payload, что уже видит публичный
    // оверлей (OverlayData.matches, см. use-overlay-polling.ts) - только
    // финализированные матчи ТЕКУЩЕЙ сессии, без нового запроса к backend.
    recentMatches: StreamMatch[];
    // Полная authenticated-история (GET .../account/me/matches) - в отличие
    // от компактного превью, каждая строка редактируема (см. задачу, п.4).
    matches: AccountStreamMatch[] | null;
    // WK-84: id активной stream-сессии - только чтобы отличить в "Полной
    // истории" матчи текущего стрима (opacity 1) от прошлых (~0.8), см.
    // isMatchFromCurrentSession. null, пока сессия ещё не загрузилась -
    // тогда все строки временно считаются текущими (см. хелпер).
    activeSessionId: string | null;
    onUpdated: (updated: AccountStreamMatch) => void;
}

// PATCH возвращает и обновлённый матч, и актуальную session summary - но
// пересчитанные значения соседних матчей (каскад) в текущий список сами по
// себе не подтягиваются без перезагрузки списка, поэтому после любой правки
// достаточно переоткрыть страницу, чтобы увидеть весь пересчитанный хвост;
// сама отредактированная строка обновляется сразу.
export const RecentMatchesPanel = ({
    recentMatches,
    matches,
    activeSessionId,
    onUpdated,
}: RecentMatchesPanelProps) => {
    const [messageApi, contextHolder] = message.useMessage();

    // Полная история - под Collapse (см. задачу, п.4: "необязательные
    // настройки можно убрать в Collapse/Drawer") - на мобильном первым
    // кадром видна только компактный список, а не весь список сразу.
    const historyItems: CollapseProps["items"] = matches
        ? [
              {
                  key: "history",
                  label: `Полная история (${matches.length})`,
                  children: (
                      <div className={styles.list}>
                          {matches.map((match) => (
                              <MatchRow
                                  key={match.id}
                                  match={match}
                                  isCurrentSession={isMatchFromCurrentSession(
                                      match.streamSessionId,
                                      activeSessionId
                                  )}
                                  onUpdated={onUpdated}
                                  messageApi={messageApi}
                              />
                          ))}
                      </div>
                  ),
              },
          ]
        : [];

    return (
        <div className={sharedStyles.section}>
            {contextHolder}
            <h2 className={sharedStyles.sectionTitle}>Последние матчи</h2>

            {recentMatches.length === 0 ? (
                <div className={styles.empty}>Матчей в этой сессии пока нет</div>
            ) : (
                <div className={styles.compactList}>
                    {recentMatches.slice(0, 5).map((match) => (
                        <CompactMatchRow key={match.id} match={match} />
                    ))}
                </div>
            )}

            {matches === null ? (
                <div className={styles.loading}>Загрузка истории…</div>
            ) : matches.length === 0 ? null : (
                <Collapse
                    className={styles.historyCollapse}
                    items={historyItems}
                    defaultActiveKey={[]}
                    ghost
                />
            )}
        </div>
    );
};
