"use client";

import Link from "next/link";
import { Button, Switch, message } from "antd";
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
        </section>
    );
};
