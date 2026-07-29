"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { Button, Input, Switch, message } from "antd";
import { DOTA_HEROES } from "@/entities/dota-hero/model/heroes";
import type { DotaHeroAttribute } from "@/entities/dota-hero/model/attributes";
import { useQueueSettings } from "@/entities/stream-queue-settings/lib/use-queue-settings";
import type { QueueWidgetId } from "@/entities/stream-queue-settings/model/types";
import styles from "./queue-widgets-panel.module.scss";

const LABELS: Record<QueueWidgetId, string> = {
    playerProfile: "Профиль и статистика",
    streamProfile: "Канал и трансляция",
    featuredMatch: "Последний матч",
    webcam: "Область веб-камеры",
    favoriteHeroes: "Любимые герои",
    recentGames: "Последние игры",
    twitchChat: "Twitch-чат",
    systemStatus: "Статусы интеграций",
};

const ATTRIBUTES: Array<{
    id: DotaHeroAttribute;
    label: string;
    mark: string;
}> = [
    { id: "strength", label: "Сила", mark: "◆" },
    { id: "agility", label: "Ловкость", mark: "▲" },
    { id: "intelligence", label: "Интеллект", mark: "●" },
    { id: "universal", label: "Универсальные", mark: "✦" },
];

export const QueueWidgetsPanel = () => {
    const { settings, loading, save } = useQueueSettings();
    const [messageApi, contextHolder] = message.useMessage();
    const [heroQuery, setHeroQuery] = useState("");
    const filteredHeroes = useMemo(() => {
        const query = heroQuery.trim().toLocaleLowerCase();
        return query
            ? DOTA_HEROES.filter((hero) =>
                  hero.localizedName.toLocaleLowerCase().includes(query)
              )
            : DOTA_HEROES;
    }, [heroQuery]);

    const toggle = async (id: QueueWidgetId, visible: boolean) => {
        try {
            await save({
                ...settings,
                visibility: { ...settings.visibility, [id]: visible },
            });
        } catch {
            messageApi.error("Не удалось сохранить настройки queue");
        }
    };

    const toggleFavoriteHero = async (heroId: number) => {
        const selected = settings.favoriteHeroIds.includes(heroId);
        const heroIds = selected
            ? settings.favoriteHeroIds.filter((id) => id !== heroId)
            : [...settings.favoriteHeroIds, heroId];
        if (heroIds.length > 3) {
            messageApi.warning("Можно выбрать не больше трёх героев");
            return;
        }
        try {
            await save({ ...settings, favoriteHeroIds: heroIds });
        } catch {
            messageApi.error("Не удалось сохранить любимых героев");
        }
    };

    return (
        <section className={styles.section}>
            {contextHolder}
            <div className={styles.header}>
                <div>
                    <h2>Виджеты Queue</h2>
                    <p>Управляйте блоками экрана поиска матча. Настройки сохраняются в аккаунте.</p>
                </div>
                <Link href="/stream/queue"><Button>Открыть Queue</Button></Link>
            </div>
            <div className={styles.grid} aria-busy={loading}>
                {(Object.keys(LABELS) as QueueWidgetId[]).map((id) => (
                    <label key={id} className={styles.row}>
                        <span>{LABELS[id]}</span>
                        <Switch
                            checked={settings.visibility[id]}
                            disabled={loading}
                            onChange={(checked) => void toggle(id, checked)}
                        />
                    </label>
                ))}
            </div>
            <div className={styles.heroPicker}>
                <div className={styles.heroPickerHeader}>
                    <div>
                    <strong>Герои в Favorite Heroes</strong>
                    <span>Выберите до трёх. Пустой список — автоматически по истории матчей.</span>
                    </div>
                    <div className={styles.heroPickerTools}>
                        <span className={styles.selectionCount}>
                            {settings.favoriteHeroIds.length} / 3
                        </span>
                        <Input
                            allowClear
                            value={heroQuery}
                            placeholder="Поиск героя"
                            onChange={(event) => setHeroQuery(event.target.value)}
                        />
                    </div>
                </div>
                <div className={styles.attributeGrid}>
                    {ATTRIBUTES.map((attribute) => {
                        const heroes = filteredHeroes
                            .filter((hero) => hero.attribute === attribute.id)
                            .sort((a, b) => a.localizedName.localeCompare(b.localizedName));
                        return (
                            <section
                                key={attribute.id}
                                className={styles.attributeColumn}
                                data-attribute={attribute.id}
                            >
                                <h3><i>{attribute.mark}</i>{attribute.label}</h3>
                                <div className={styles.heroGrid}>
                                    {heroes.map((hero) => {
                                        const selected = settings.favoriteHeroIds.includes(hero.id);
                                        const disabled =
                                            loading ||
                                            (!selected && settings.favoriteHeroIds.length >= 3);
                                        return (
                                            <button
                                                key={hero.id}
                                                type="button"
                                                className={styles.heroTile}
                                                data-selected={selected}
                                                disabled={disabled}
                                                title={hero.localizedName}
                                                onClick={() => void toggleFavoriteHero(hero.id)}
                                            >
                                                <img src={hero.imageUrl} alt="" />
                                                <span>{hero.localizedName}</span>
                                                <b aria-hidden="true">✓</b>
                                            </button>
                                        );
                                    })}
                                </div>
                            </section>
                        );
                    })}
                </div>
            </div>
        </section>
    );
};
