"use client";

import Link from "next/link";
import { Button, Select, Switch, message } from "antd";
import { DOTA_HEROES } from "@/entities/dota-hero/model/heroes";
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

export const QueueWidgetsPanel = () => {
    const { settings, loading, save } = useQueueSettings();
    const [messageApi, contextHolder] = message.useMessage();

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

    const selectFavoriteHeroes = async (heroIds: number[]) => {
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
                <div>
                    <strong>Герои в Favorite Heroes</strong>
                    <span>Выберите до трёх. Пустой список — автоматически по истории матчей.</span>
                </div>
                <Select
                    mode="multiple"
                    maxCount={3}
                    showSearch
                    allowClear
                    value={settings.favoriteHeroIds}
                    disabled={loading}
                    placeholder="Автоматический выбор"
                    optionFilterProp="label"
                    options={DOTA_HEROES.map((hero) => ({
                        value: hero.id,
                        label: hero.localizedName,
                    }))}
                    onChange={(ids) => void selectFavoriteHeroes(ids)}
                />
            </div>
        </section>
    );
};
