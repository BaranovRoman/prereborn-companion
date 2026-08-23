"use client";

import { Button, Popconfirm, Switch, message } from "antd";
import { twitchIntegrationApi } from "@/entities/twitch-integration/api/twitch-integration";
import type { TwitchIntegrationStatus } from "@/entities/twitch-integration/model/types";
import { useViewerAlertsSettings } from "@/entities/twitch-viewer-alerts/lib/use-viewer-alerts-settings";
import sharedStyles from "./index.module.scss";
import styles from "./steam-integration-panel.module.scss";

const VIEWER_ALERT_TYPE_LABELS = {
    follow: "Фоллоу",
    subscribe: "Подписка",
    giftSub: "Подарочная подписка",
    raid: "Рейд",
} as const;

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
    const viewerAlerts = useViewerAlertsSettings();
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
                    {/* WK-72 - follow/subscribe/gift-sub/raid overlay alerts.
                        Only meaningful once Twitch is connected - a
                        disconnected channel can't produce any of these
                        events, so the toggles stay out of the way until
                        there's something to toggle. */}
                    <div className={styles.metaLine} style={{ marginTop: 16 }}>
                        <Switch
                            size="small"
                            checked={viewerAlerts.settings.enabled}
                            loading={viewerAlerts.loading}
                            onChange={(enabled) => void viewerAlerts.save({ ...viewerAlerts.settings, enabled })}
                        />{" "}
                        Уведомления о фоллоу/подписках/рейдах на overlay
                    </div>
                    {viewerAlerts.settings.enabled && (
                        <div className={styles.metaLine} style={{ display: "flex", gap: 16, flexWrap: "wrap", marginTop: 8 }}>
                            {(Object.keys(VIEWER_ALERT_TYPE_LABELS) as Array<keyof typeof VIEWER_ALERT_TYPE_LABELS>).map((type) => (
                                <label key={type} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                                    <Switch
                                        size="small"
                                        checked={viewerAlerts.settings.types[type]}
                                        loading={viewerAlerts.loading}
                                        onChange={(checked) => void viewerAlerts.save({
                                            ...viewerAlerts.settings,
                                            types: { ...viewerAlerts.settings.types, [type]: checked },
                                        })}
                                    />
                                    {VIEWER_ALERT_TYPE_LABELS[type]}
                                </label>
                            ))}
                        </div>
                    )}
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
