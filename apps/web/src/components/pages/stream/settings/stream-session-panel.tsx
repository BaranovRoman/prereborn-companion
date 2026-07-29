"use client";

import { useEffect, useRef, useState } from "react";
import { Button, InputNumber, Popconfirm, Select, message } from "antd";
import type { DefaultOptionType } from "antd/es/select";
import { streamSessionApi } from "@/entities/stream-session/api/stream-session";
import { DOTA_HEROES } from "@/entities/dota-hero/model/heroes";
import { getHeroById } from "@/entities/dota-hero/lib/search";
import type { DotaHero } from "@/entities/dota-hero/model/types";
import type { StreamSession } from "@/entities/stream-session/model/types";
import type { StreamGameMode } from "@/entities/stream-user/model/types";
import { GameModePanel } from "./game-mode-panel";
import sharedStyles from "./index.module.scss";
import styles from "./stream-session-panel.module.scss";

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
}

export const StreamSessionPanel = ({
    steamConnected,
    sessionRatingDelta,
    gameMode,
    onGameModeChanged,
}: StreamSessionPanelProps) => {
    const [session, setSession] = useState<StreamSession | null>(null);
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

    useEffect(() => {
        let cancelled = false;
        streamSessionApi
            .get()
            .then((loaded) => {
                if (cancelled) return;
                setSession(loaded);
                setRatingInput(loaded.rating);
                lastSavedRatingRef.current = loaded.rating;
                setLoading(false);
            })
            .catch(() => {
                if (!cancelled) setLoading(false);
            });
        return () => {
            cancelled = true;
        };
    }, []);

    // Только перечитывание (GET), не трогает rating-инпут/busy-флаги -
    // W/L/герой, изменённые фоновым sync'ом, подтягиваются сюда так же, как
    // overlay подтягивает их поллингом (use-overlay-polling.ts), но реже:
    // sync и так не чаще раза в 45-60с, обновлять локальный дисплей чаще
    // незачем.
    useEffect(() => {
        if (!steamConnected) return;
        let cancelled = false;
        let timeoutId: ReturnType<typeof setTimeout>;

        const poll = async () => {
            try {
                const loaded = await streamSessionApi.get();
                if (!cancelled) setSession(loaded);
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
    }, [steamConnected]);

    const handleRatingBlur = async () => {
        if (ratingInput === lastSavedRatingRef.current) return;
        setRatingSaving(true);
        try {
            const updated = await streamSessionApi.patch({ rating: ratingInput });
            setSession(updated);
            lastSavedRatingRef.current = updated.rating;
            setRatingInput(updated.rating);
        } catch {
            messageApi.error("Не удалось сохранить рейтинг");
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
        setSession({ ...session, [field]: nextValue });
        try {
            const updated = await streamSessionApi.patch({ [field]: nextValue });
            setSession(updated);
        } catch {
            setSession((current) =>
                current ? { ...current, [field]: prevValue } : current
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
        setSession({ ...session, lastHeroId: nextHeroId });
        try {
            const updated = await streamSessionApi.patch({
                lastHeroId: nextHeroId,
            });
            setSession(updated);
        } catch {
            setSession((current) =>
                current ? { ...current, lastHeroId: prevHeroId } : current
            );
            messageApi.error("Не удалось сохранить героя");
        } finally {
            setHeroSaving(false);
        }
    };

    const handleReset = async () => {
        setIsResetting(true);
        try {
            const updated = await streamSessionApi.reset();
            setSession(updated);
            setRatingInput(updated.rating);
            lastSavedRatingRef.current = updated.rating;
            messageApi.success("Новый стрим начат");
        } catch {
            messageApi.error("Не удалось сбросить статистику");
        } finally {
            setIsResetting(false);
        }
    };

    if (loading || !session) {
        return (
            <div className={styles.card}>
                <h2 className={sharedStyles.sectionTitle}>Текущий стрим</h2>
                <div className={styles.sessionLoading}>Загрузка…</div>
            </div>
        );
    }

    const lastHero = session.lastHeroId ? getHeroById(session.lastHeroId) : undefined;
    const isRanked = gameMode === "ranked";
    const showDelta = isRanked && sessionRatingDelta !== null;

    return (
        <div className={styles.card}>
            {contextHolder}
            <div className={styles.cardHeader}>
                <h2 className={sharedStyles.sectionTitle}>Текущий стрим</h2>
                <Popconfirm
                    title="Начать новый стрим?"
                    description="Победы, поражения и последний герой обнулятся. Рейтинг сохранится."
                    okText="Начать"
                    cancelText="Отмена"
                    onConfirm={handleReset}
                >
                    <Button loading={isResetting} className={styles.resetButton}>
                        Начать новый стрим
                    </Button>
                </Popconfirm>
            </div>

            <div className={styles.modeRow}>
                <GameModePanel gameMode={gameMode} onChanged={onGameModeChanged} />
            </div>

            <div className={styles.statsRow}>
                <div className={styles.statBlock}>
                    <span className={styles.statLabel}>Рейтинг</span>
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
