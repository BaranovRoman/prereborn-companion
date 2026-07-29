"use client";

import { Button, Popconfirm, message } from "antd";
import { twitchIntegrationApi } from "@/entities/twitch-integration/api/twitch-integration";
import type { TwitchIntegrationStatus } from "@/entities/twitch-integration/model/types";
import sharedStyles from "./index.module.scss";
import styles from "./steam-integration-panel.module.scss";

export const TwitchIntegrationPanel = ({
    status,
    loading,
    onChanged,
}: {
    status: TwitchIntegrationStatus | null;
    loading: boolean;
    onChanged: () => void;
}) => {
    const [messageApi, contextHolder] = message.useMessage();
    const connect = async () => {
        try { await twitchIntegrationApi.connect(); }
        catch { messageApi.error("Не удалось начать подключение Twitch"); }
    };
    const disconnect = async () => {
        try {
            await twitchIntegrationApi.disconnect();
            await onChanged();
            messageApi.success("Twitch отключён");
        } catch { messageApi.error("Не удалось отключить Twitch"); }
    };
    return (
        <div className={sharedStyles.section}>
            {contextHolder}
            <h2 className={sharedStyles.sectionTitle}>Twitch</h2>
            {loading ? (
                <div className={styles.metaLine}>Загрузка…</div>
            ) : status?.connected ? (
                <>
                    <div className={styles.statusLine}>
                        Канал {status.displayName || status.login} подключён
                    </div>
                    <div className={styles.metaLine}>
                        {status.live
                            ? `В эфире · ${status.live.viewerCount} зрителей · ${status.live.gameName}`
                            : "Сейчас не в эфире"}
                    </div>
                    <div className={styles.actions}>
                        <Popconfirm
                            title="Отключить Twitch?"
                            okText="Отключить"
                            cancelText="Отмена"
                            onConfirm={disconnect}
                        >
                            <Button danger type="text">Отключить Twitch</Button>
                        </Popconfirm>
                    </div>
                </>
            ) : (
                <>
                    <div className={styles.statusLine}>Twitch не подключён</div>
                    <div className={styles.actions}>
                        <Button type="primary" disabled={!status?.configured} onClick={connect}>
                            Подключить Twitch
                        </Button>
                    </div>
                    <div className={styles.hint}>
                        {status?.configured
                            ? "Канал, статус трансляции и настоящий чат появятся на странице queue."
                            : "Добавьте Twitch Client ID и Client Secret в настройки сервера."}
                    </div>
                </>
            )}
        </div>
    );
};
