"use client";

import { Button, Popconfirm, message } from "antd";
import { steamIntegrationApi } from "@/entities/steam-integration/api/steam-integration";
import type { SteamIntegrationStatus } from "@/entities/steam-integration/model/types";
import sharedStyles from "./index.module.scss";
import styles from "./steam-integration-panel.module.scss";

interface SteamIntegrationPanelProps {
    status: SteamIntegrationStatus | null;
    loading: boolean;
    isSyncing: boolean;
    onSync: () => void;
    onDisconnected: () => void;
}

const formatTime = (iso: string): string =>
    new Date(iso).toLocaleTimeString("ru-RU", {
        hour: "2-digit",
        minute: "2-digit",
    });

// Только сообщения для реально различимых состояний OpenDota. "Приватная
// история" и "матчей пока нет" эмпирически неразличимы через recentMatches
// (оба - HTTP 200 []) - выдумывать для них отдельный статус не стали (см.
// комментарий в dota-match-provider.ts), поэтому текст-подсказка про
// приватность в .hint показывается всегда, а не только "когда точно
// известно", что это приватность.
const SYNC_STATUS_LABELS: Record<string, string> = {
    ok: "данные актуальны",
    not_found: "аккаунт не найден в OpenDota",
    rate_limited: "OpenDota временно недоступна (лимит запросов), повторим позже",
    unavailable: "OpenDota временно недоступна, повторим позже",
};

export const SteamIntegrationPanel = ({
    status,
    loading,
    isSyncing,
    onSync,
    onDisconnected,
}: SteamIntegrationPanelProps) => {
    const [messageApi, contextHolder] = message.useMessage();

    const handleConnect = async () => {
        try {
            await steamIntegrationApi.connect();
        } catch {
            messageApi.error("Не удалось начать привязку Steam");
        }
    };

    const handleDisconnect = async () => {
        try {
            await steamIntegrationApi.disconnect();
            messageApi.success("Steam отвязан");
            onDisconnected();
        } catch {
            messageApi.error("Не удалось отвязать Steam");
        }
    };

    if (loading || !status) {
        return (
            <div className={sharedStyles.section}>
                {contextHolder}
                <h2 className={sharedStyles.sectionTitle}>Steam и Dota</h2>
                <div className={styles.metaLine}>Загрузка…</div>
            </div>
        );
    }

    if (!status.connected) {
        return (
            <div className={sharedStyles.section}>
                {contextHolder}
                <h2 className={sharedStyles.sectionTitle}>Steam и Dota</h2>
                <div className={styles.statusLine}>Steam не подключён</div>
                <div className={styles.actions}>
                    <Button type="primary" onClick={handleConnect}>
                        Привязать Steam
                    </Button>
                </div>
                <div className={styles.hint}>
                    После привязки победы, поражения и последний герой будут
                    обновляться автоматически по вашим матчам Dota 2.
                </div>
            </div>
        );
    }

    const syncStatusLabel = status.lastSyncStatus
        ? SYNC_STATUS_LABELS[status.lastSyncStatus] ?? status.lastSyncStatus
        : "синхронизация ещё не выполнялась";

    return (
        <div className={sharedStyles.section}>
            {contextHolder}
            <h2 className={sharedStyles.sectionTitle}>Steam и Dota</h2>
            <div className={styles.statusLine}>Steam подключён</div>
            {status.lastSyncedAt && (
                <div className={styles.metaLine}>
                    Последняя синхронизация: {formatTime(status.lastSyncedAt)}
                </div>
            )}
            <div className={styles.metaLine}>Статус: {syncStatusLabel}</div>

            {(status.lastSyncStatus === "not_found" ||
                status.lastSyncStatus === "unavailable" ||
                status.lastSyncStatus === "rate_limited") && (
                <div className={styles.errorLine}>
                    Не удалось получить историю матчей. Проверьте, что в Dota
                    включена настройка «Показывать общедоступную историю
                    матчей», и что аккаунт действительно привязан к этому Steam.
                </div>
            )}

            <div className={styles.actions}>
                <Button onClick={onSync} loading={isSyncing}>
                    Синхронизировать сейчас
                </Button>
                <Popconfirm
                    title="Отвязать Steam?"
                    description="Автоматическое обновление W/L и героя остановится. История матчей и OBS URL не пострадают."
                    okText="Отвязать"
                    cancelText="Отмена"
                    onConfirm={handleDisconnect}
                >
                    <Button danger type="text">
                        Отвязать Steam
                    </Button>
                </Popconfirm>
            </div>
        </div>
    );
};
