"use client";

import { useEffect, useRef, useState } from "react";
import { Button, InputNumber, Popconfirm, Select, message } from "antd";
import type { DefaultOptionType } from "antd/es/select";
import { streamSessionApi } from "@/entities/stream-session/api/stream-session";
import { DOTA_HEROES } from "@/entities/dota-hero/model/heroes";
import { getHeroById } from "@/entities/dota-hero/lib/search";
import type { DotaHero } from "@/entities/dota-hero/model/types";
import type {
    SessionLifecycleResponse,
    SessionSummary,
    StreamSession,
} from "@/entities/stream-session/model/types";
import type { StreamGameMode } from "@/entities/stream-user/model/types";
import { GameModePanel } from "./game-mode-panel";
import sharedStyles from "./index.module.scss";
import styles from "./stream-session-panel.module.scss";

const formatDateTime = (iso: string | null) =>
    iso
        ? new Intl.DateTimeFormat("ru-RU", {
              day: "2-digit",
              month: "2-digit",
              hour: "2-digit",
              minute: "2-digit",
          }).format(new Date(iso))
        : "—";

const formatDuration = (durationMs: number | null) => {
    if (durationMs === null || durationMs < 0) return "—";
    const totalMinutes = Math.round(durationMs / 60_000);
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    if (hours === 0) return `${minutes} мин`;
    return `${hours} ч ${minutes} мин`;
};

const formatSummaryDelta = (delta: number | null) => {
    if (delta === null) return null;
    if (delta === 0) return "±0";
    return delta > 0 ? `+${delta}` : `${delta}`;
};

// WK-53 - "итог стрима" card shown once the most recent session has been
// explicitly ended. Reuses the same statBlock/statValue visual language as
// the active-session view above - see stream-session-panel.module.scss.
const EndedSessionSummary = ({ summary }: { summary: SessionSummary }) => {
    const total = summary.wins + summary.losses;
    const delta = summary.gameMode === "ranked" ? formatSummaryDelta(summary.ratingDelta) : null;

    return (
        <div className={styles.statsRow}>
            <div className={styles.statBlock}>
                <span className={styles.statLabel}>W / L</span>
                <div className={styles.statValue}>
                    {summary.wins}–{summary.losses}
                </div>
            </div>
            <div className={styles.statBlock}>
                <span className={styles.statLabel}>Матчей</span>
                <div className={styles.statValue}>{summary.matchCount || total}</div>
            </div>
            {summary.gameMode === "ranked" && (
                <div className={styles.statBlock}>
                    <span className={styles.statLabel}>MMR</span>
                    <div className={styles.ratingRow}>
                        <span className={styles.statValue}>
                            {summary.ratingStart ?? "—"} → {summary.ratingEnd ?? "—"}
                        </span>
                        {delta && (
                            <span
                                className={
                                    (summary.ratingDelta ?? 0) >= 0
                                        ? styles.deltaPositive
                                        : styles.deltaNegative
                                }
                            >
                                {delta}
                            </span>
                        )}
                    </div>
                    {/* WK-105 - delta выше = только матчи (см. ratingDelta в
                        SessionSummary), поэтому ratingStart + delta честно
                        может не сойтись с ratingEnd, если была абсолютная
                        коррекция "Текущего MMR" - показываем её отдельной
                        строкой, а не молчим о расхождении. */}
                    {summary.ratingAdjustment !== 0 && (
                        <div className={styles.savingHint}>
                            включая ручную коррекцию Текущего MMR:{" "}
                            {summary.ratingAdjustment > 0 ? "+" : ""}
                            {summary.ratingAdjustment}
                        </div>
                    )}
                </div>
            )}
            <div className={styles.statBlock}>
                <span className={styles.statLabel}>Начало</span>
                <div className={styles.statValue}>{formatDateTime(summary.startedAt)}</div>
            </div>
            <div className={styles.statBlock}>
                <span className={styles.statLabel}>Конец</span>
                <div className={styles.statValue}>{formatDateTime(summary.endedAt)}</div>
            </div>
            <div className={styles.statBlock}>
                <span className={styles.statLabel}>Длительность</span>
                <div className={styles.statValue}>{formatDuration(summary.durationMs)}</div>
            </div>
        </div>
    );
};

type CounterField = "wins" | "losses";

interface HeroOption extends DefaultOptionType {
    value: number;
    label: string;
    hero: DotaHero;
}

const HERO_OPTIONS: HeroOption[] = DOTA_HEROES.map((hero) => ({
    value: hero.id,
    label: hero.localizedName,
    hero,
}));

// Пока Steam подключён, W/L и герой обновляет фоновый sync
// (use-steam-integration.ts) - эта панель их сама не меняет, только
// периодически перечитывает, чтобы не показывать протухшие значения.
const SESSION_REFRESH_INTERVAL_MS = 10_000;

interface StreamSessionPanelProps {
    steamConnected: boolean;
    // Изменение рейтинга за текущую сессию - backend уже считает его для
    // публичного оверлея (OverlayData.sessionRatingDelta, см. use-overlay-
    // polling.ts), поэтому здесь не пересчитывается заново, а просто
    // приходит сверху (settings/index.tsx), чтобы не заводить второй способ
    // считать то же самое число.
    sessionRatingDelta: number | null;
    gameMode: StreamGameMode;
    onGameModeChanged: (gameMode: StreamGameMode) => void;
    // WK-84: эта панель - единственное место на странице, которое уже знает
    // id активной сессии (см. эффект ниже) и единственное, где он меняется
    // (poll + "Начать новый стрим"), поэтому просто оповещаем родителя вместо
    // того, чтобы RecentMatchesPanel заводил свой параллельный fetch того же
    // /account/session.
    onSessionChange?: (session: StreamSession) => void;
}

export const StreamSessionPanel = ({
    steamConnected,
    sessionRatingDelta,
    gameMode,
    onGameModeChanged,
    onSessionChange,
}: StreamSessionPanelProps) => {
    // WK-53 - three-state lifecycle (active/ended/none), not just a
    // StreamSession - see model/types.ts. `session` below is a convenience
    // accessor for the currently-displayed session (active OR the most
    // recently ended one); the EDITABLE controls (rating input, W/L
    // counters, hero select, reset/end buttons) are still gated on
    // lifecycle.state === "active" specifically.
    const [lifecycle, setLifecycle] = useState<SessionLifecycleResponse | null>(null);
    const [loading, setLoading] = useState(true);
    const [messageApi, contextHolder] = message.useMessage();

    const [ratingInput, setRatingInput] = useState<number | null>(null);
    const [ratingSaving, setRatingSaving] = useState(false);
    const lastSavedRatingRef = useRef<number | null>(null);

    const counterBusyRef = useRef<Record<CounterField, boolean>>({
        wins: false,
        losses: false,
    });
    const [heroSaving, setHeroSaving] = useState(false);
    const [isResetting, setIsResetting] = useState(false);
    const [isEnding, setIsEnding] = useState(false);

    const session = lifecycle?.session ?? null;
    const isActive = lifecycle?.state === "active";

    useEffect(() => {
        let cancelled = false;
        streamSessionApi
            .get()
            .then((loaded) => {
                if (cancelled) return;
                setLifecycle(loaded);
                setRatingInput(loaded.session?.rating ?? null);
                lastSavedRatingRef.current = loaded.session?.rating ?? null;
                setLoading(false);
            })
            .catch(() => {
                if (!cancelled) setLoading(false);
            });
        return () => {
            cancelled = true;
        };
    }, []);

    useEffect(() => {
        if (session) onSessionChange?.(session);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [session]);

    // Только перечитывание (GET), не трогает rating-инпут/busy-флаги -
    // W/L/герой, изменённые фоновым sync'ом, подтягиваются сюда так же, как
    // overlay подтягивает их поллингом (use-overlay-polling.ts), но реже:
    // sync и так не чаще раза в 45-60с, обновлять локальный дисплей чаще
    // незачем. Only while active - an ended session's numbers are fixed by
    // definition, no background sync will move them.
    useEffect(() => {
        if (!steamConnected || !isActive) return;
        let cancelled = false;
        let timeoutId: ReturnType<typeof setTimeout>;

        const poll = async () => {
            try {
                const loaded = await streamSessionApi.get();
                if (!cancelled) setLifecycle(loaded);
            } catch {
                // Временная ошибка - оставляем текущее отображение как есть.
            }
            if (!cancelled) {
                timeoutId = setTimeout(poll, SESSION_REFRESH_INTERVAL_MS);
            }
        };

        timeoutId = setTimeout(poll, SESSION_REFRESH_INTERVAL_MS);
        return () => {
            cancelled = true;
            clearTimeout(timeoutId);
        };
    }, [steamConnected, isActive]);

    // WK-105 - "Установить текущий MMR": абсолютная коррекция точки отсчёта
    // (backend: applyAbsoluteRatingCorrection), НЕ переписывание истории
    // матчей - см. задачу. previousRating берём из lastSavedRatingRef (что
    // реально было сохранено до этого блюра), а не из ratingInput на входе в
    // функцию, чтобы сообщение показывало настоящую разницу, даже если
    // пользователь поправил поле пару раз подряд без промежуточного сохранения.
    const handleRatingBlur = async () => {
        const previousRating = lastSavedRatingRef.current;
        if (ratingInput === previousRating) return;
        setRatingSaving(true);
        try {
            const updated = await streamSessionApi.patch({ rating: ratingInput });
            setLifecycle((current) => (current ? { ...current, session: updated } : current));
            lastSavedRatingRef.current = updated.rating;
            setRatingInput(updated.rating);
            if (previousRating !== null && updated.rating !== null) {
                const diff = updated.rating - previousRating;
                if (diff !== 0) {
                    messageApi.success(
                        `Текущий MMR скорректирован с ${previousRating} до ${updated.rating} ` +
                            `(${diff > 0 ? "+" : ""}${diff}). История матчей не изменится.`
                    );
                }
            } else if (updated.rating !== null) {
                messageApi.success(`Текущий MMR установлен: ${updated.rating}.`);
            }
        } catch {
            messageApi.error("Не удалось сохранить MMR");
            setRatingInput(lastSavedRatingRef.current);
        } finally {
            setRatingSaving(false);
        }
    };

    // Optimistic update + блокировка повторного клика до ответа (per-field
    // busy-флаг в ref, не в state - не должен вызывать лишний ре-рендер).
    // На ошибке откатываем именно к prevValue, а не перезапрашиваем сессию -
    // так UI не может залипнуть в неверном состоянии молча.
    const adjustCounter = async (field: CounterField, delta: number) => {
        if (!session || counterBusyRef.current[field]) return;
        const prevValue = session[field];
        const nextValue = Math.max(0, prevValue + delta);
        if (nextValue === prevValue) return;

        counterBusyRef.current[field] = true;
        setLifecycle((current) =>
            current && current.session
                ? { ...current, session: { ...current.session, [field]: nextValue } }
                : current
        );
        try {
            const updated = await streamSessionApi.patch({ [field]: nextValue });
            setLifecycle((current) => (current ? { ...current, session: updated } : current));
        } catch {
            setLifecycle((current) =>
                current && current.session
                    ? { ...current, session: { ...current.session, [field]: prevValue } }
                    : current
            );
            messageApi.error("Не удалось сохранить");
        } finally {
            counterBusyRef.current[field] = false;
        }
    };

    const handleHeroChange = async (heroId: number | undefined) => {
        if (!session) return;
        const nextHeroId = heroId ?? null;
        const prevHeroId = session.lastHeroId;
        if (nextHeroId === prevHeroId) return;

        setHeroSaving(true);
        setLifecycle((current) =>
            current && current.session
                ? { ...current, session: { ...current.session, lastHeroId: nextHeroId } }
                : current
        );
        try {
            const updated = await streamSessionApi.patch({
                lastHeroId: nextHeroId,
            });
            setLifecycle((current) => (current ? { ...current, session: updated } : current));
        } catch {
            setLifecycle((current) =>
                current && current.session
                    ? { ...current, session: { ...current.session, lastHeroId: prevHeroId } }
                    : current
            );
            messageApi.error("Не удалось сохранить героя");
        } finally {
            setHeroSaving(false);
        }
    };

    // "Начать новый стрим" - works from any lifecycle state (active/ended/
    // none), see streamSessionApi.reset()/backend resetActiveSession.
    const handleReset = async () => {
        setIsResetting(true);
        try {
            const updated = await streamSessionApi.reset();
            setLifecycle({ state: "active", session: updated, summary: null });
            setRatingInput(updated.rating);
            lastSavedRatingRef.current = updated.rating;
            messageApi.success("Новый стрим начат");
        } catch {
            messageApi.error("Не удалось сбросить статистику");
        } finally {
            setIsResetting(false);
        }
    };

    // WK-53 - self-service "Завершить стрим": closes the active session
    // WITHOUT opening a new one (see endSessionController) - the streamer
    // sees the итог immediately, no separate reload/navigation needed.
    // Idempotent server-side, so a double-click here just re-renders the
    // same summary rather than erroring.
    const handleEnd = async () => {
        setIsEnding(true);
        try {
            const { session: ended, summary } = await streamSessionApi.end();
            setLifecycle({ state: "ended", session: ended, summary });
            messageApi.success("Стрим завершён");
        } catch {
            messageApi.error("Не удалось завершить стрим");
        } finally {
            setIsEnding(false);
        }
    };

    if (loading || !lifecycle) {
        return (
            <div className={styles.card}>
                <h2 className={`${sharedStyles.sectionTitle} ${styles.cardTitle}`}>Текущий стрим</h2>
                <div className={styles.sessionLoading}>Загрузка…</div>
            </div>
        );
    }

    if (lifecycle.state !== "active") {
        return (
            <div className={styles.card}>
                {contextHolder}
                <div className={styles.cardHeader}>
                    <h2 className={`${sharedStyles.sectionTitle} ${styles.cardTitle}`}>
                        {lifecycle.state === "ended" ? "Стрим завершён" : "Текущий стрим"}
                    </h2>
                    <Button
                        type="primary"
                        loading={isResetting}
                        className={styles.resetButton}
                        onClick={handleReset}
                    >
                        Начать новый стрим
                    </Button>
                </div>

                <div className={styles.modeRow}>
                    <GameModePanel gameMode={gameMode} onChanged={onGameModeChanged} />
                </div>

                {lifecycle.state === "ended" && lifecycle.summary ? (
                    <EndedSessionSummary summary={lifecycle.summary} />
                ) : (
                    <div className={styles.sessionLoading}>
                        Стрим ещё не начат. Начните, когда будете готовы.
                    </div>
                )}
            </div>
        );
    }

    if (!session) {
        // Defensive only - the backend contract guarantees state === "active"
        // always carries a session (see controllers/stream/session.ts).
        return null;
    }

    const lastHero = session.lastHeroId ? getHeroById(session.lastHeroId) : undefined;
    const isRanked = gameMode === "ranked";
    const showDelta = isRanked && sessionRatingDelta !== null;

    return (
        <div className={styles.card}>
            {contextHolder}
            <div className={styles.cardHeader}>
                <h2 className={`${sharedStyles.sectionTitle} ${styles.cardTitle}`}>Текущий стрим</h2>
                <div className={styles.headerActions}>
                    <Popconfirm
                        title="Завершить стрим?"
                        description="Итог текущей сессии сохранится. Новую сессию нужно будет начать отдельно."
                        okText="Завершить"
                        cancelText="Отмена"
                        onConfirm={handleEnd}
                    >
                        <Button loading={isEnding} className={styles.endButton}>
                            Завершить стрим
                        </Button>
                    </Popconfirm>
                    <Popconfirm
                        title="Начать новый стрим?"
                        description="Победы, поражения и последний герой обнулятся. Текущий MMR сохранится."
                        okText="Начать"
                        cancelText="Отмена"
                        onConfirm={handleReset}
                    >
                        <Button loading={isResetting} className={styles.resetButton}>
                            Начать новый стрим
                        </Button>
                    </Popconfirm>
                </div>
            </div>

            <div className={styles.modeRow}>
                <GameModePanel gameMode={gameMode} onChanged={onGameModeChanged} />
            </div>

            <div className={styles.statsRow}>
                <div className={styles.statBlock}>
                    <span className={styles.statLabel}>Текущий MMR</span>
                    <div className={styles.ratingRow}>
                        <InputNumber
                            className={styles.ratingInput}
                            min={1}
                            precision={0}
                            placeholder="Не задан"
                            value={ratingInput}
                            onChange={(value) => setRatingInput(value)}
                            onBlur={handleRatingBlur}
                            onPressEnter={(e) => (e.target as HTMLInputElement).blur()}
                            disabled={ratingSaving}
                        />
                        {showDelta && (
                            <span
                                className={
                                    sessionRatingDelta! >= 0
                                        ? styles.deltaPositive
                                        : styles.deltaNegative
                                }
                            >
                                {sessionRatingDelta! > 0 ? "+" : ""}
                                {sessionRatingDelta}
                            </span>
                        )}
                        {ratingSaving && (
                            <span className={styles.savingHint}>Сохранение…</span>
                        )}
                    </div>
                </div>

                <div className={styles.statBlock}>
                    <span className={styles.statLabel}>W/L</span>
                    {steamConnected ? (
                        <div className={styles.statValue}>
                            {session.wins}W / {session.losses}L
                        </div>
                    ) : (
                        <div className={styles.counters}>
                            <div className={styles.counter}>
                                <span className={styles.counterValue}>{session.wins}W</span>
                                <div className={styles.counterButtons}>
                                    <Button
                                        size="small"
                                        onClick={() => adjustCounter("wins", -1)}
                                        disabled={session.wins === 0}
                                    >
                                        −
                                    </Button>
                                    <Button
                                        size="small"
                                        onClick={() => adjustCounter("wins", 1)}
                                    >
                                        +
                                    </Button>
                                </div>
                            </div>
                            <div className={styles.counter}>
                                <span className={styles.counterValue}>{session.losses}L</span>
                                <div className={styles.counterButtons}>
                                    <Button
                                        size="small"
                                        onClick={() => adjustCounter("losses", -1)}
                                        disabled={session.losses === 0}
                                    >
                                        −
                                    </Button>
                                    <Button
                                        size="small"
                                        onClick={() => adjustCounter("losses", 1)}
                                    >
                                        +
                                    </Button>
                                </div>
                            </div>
                        </div>
                    )}
                </div>

                <div className={styles.statBlock}>
                    <span className={styles.statLabel}>Последний герой</span>
                    {steamConnected ? (
                        <div className={styles.readonlyHero}>
                            {lastHero ? (
                                <>
                                    <img
                                        src={lastHero.imageUrl}
                                        alt=""
                                        className={styles.readonlyHeroIcon}
                                    />
                                    {lastHero.localizedName}
                                </>
                            ) : (
                                <span className={styles.savingHint}>Не выбран</span>
                            )}
                        </div>
                    ) : (
                        <Select<number, HeroOption>
                            className={styles.heroSelect}
                            placeholder="Не выбран"
                            value={session.lastHeroId ?? undefined}
                            onChange={handleHeroChange}
                            allowClear
                            showSearch
                            disabled={heroSaving}
                            options={HERO_OPTIONS}
                            filterOption={(input, option) => {
                                if (!option) return false;
                                const query = input.toLowerCase();
                                return (
                                    option.hero.name.toLowerCase().includes(query) ||
                                    option.hero.localizedName
                                        .toLowerCase()
                                        .includes(query)
                                );
                            }}
                            optionRender={(option) => (
                                <div className={styles.heroOption}>
                                    <img
                                        src={option.data.hero.imageUrl}
                                        alt=""
                                        className={styles.heroOptionIcon}
                                    />
                                    {option.data.hero.localizedName}
                                </div>
                            )}
                        />
                    )}
                </div>
            </div>
        </div>
    );
};
