"use client";

import { Collapse } from "antd";
import type { CollapseProps } from "antd";
import type { SteamIntegrationStatus } from "@/entities/steam-integration/model/types";
import type { OverlayCompanionState } from "@/entities/stream-session/model/types";
import { SteamIntegrationPanel } from "./steam-integration-panel";
import { CompanionPanel } from "./companion-panel";
import { TwitchIntegrationPanel } from "./twitch-integration-panel";
import type { TwitchIntegrationStatus } from "@/entities/twitch-integration/model/types";
import sharedStyles from "./index.module.scss";
import styles from "./integrations-card.module.scss";

const formatTime = (iso: string): string =>
    new Date(iso).toLocaleTimeString("ru-RU", {
        hour: "2-digit",
        minute: "2-digit",
    });

interface IntegrationsCardProps {
    steamStatus: SteamIntegrationStatus | null;
    steamLoading: boolean;
    steamIsSyncing: boolean;
    onSteamSync: () => void;
    onSteamDisconnected: () => void;
    companion: OverlayCompanionState | null;
    companionTokenConfigured: boolean;
    companionTokenCreatedAt: string | null;
    onCompanionRegenerated: (createdAt: string) => void;
    twitchStatus: TwitchIntegrationStatus | null;
    twitchLoading: boolean;
    onTwitchChanged: () => void;
}

// Steam и Companion объединены в одну вторичную карточку (см. задачу):
// компактная сводка всегда видна, технические действия (синхронизация,
// отвязка, перегенерация токена, скачивание) убраны в Collapse - оба
// исходных компонента (SteamIntegrationPanel/CompanionPanel) переиспользованы
// без изменений их логики, здесь только новая обёртка вокруг них.
export const IntegrationsCard = ({
    steamStatus,
    steamLoading,
    steamIsSyncing,
    onSteamSync,
    onSteamDisconnected,
    companion,
    companionTokenConfigured,
    companionTokenCreatedAt,
    onCompanionRegenerated,
    twitchStatus,
    twitchLoading,
    onTwitchChanged,
}: IntegrationsCardProps) => {
    const steamSummary = steamLoading
        ? "Загрузка…"
        : steamStatus?.connected
          ? `Подключён${
                steamStatus.lastSyncedAt
                    ? ` · последняя синхронизация ${formatTime(steamStatus.lastSyncedAt)}`
                    : ""
            }`
          : "Не подключён";

    const companionSummary = !companion
        ? "Нет данных"
        : companion.isOnline
          ? `Онлайн${
                companion.receivedAt
                    ? ` · получено ${formatTime(companion.receivedAt)}`
                    : ""
            }`
          : `Офлайн${
                companion.receivedAt
                    ? ` · последний раз ${formatTime(companion.receivedAt)}`
                    : ""
            }`;

    const items: CollapseProps["items"] = [
        {
            key: "manage",
            label: "Управление интеграциями",
            children: (
                <div className={styles.managementList}>
                    <SteamIntegrationPanel
                        status={steamStatus}
                        loading={steamLoading}
                        isSyncing={steamIsSyncing}
                        onSync={onSteamSync}
                        onDisconnected={onSteamDisconnected}
                    />
                    <CompanionPanel
                        companionTokenConfigured={companionTokenConfigured}
                        companionTokenCreatedAt={companionTokenCreatedAt}
                        onRegenerated={onCompanionRegenerated}
                    />
                    <TwitchIntegrationPanel
                        status={twitchStatus}
                        loading={twitchLoading}
                        onChanged={onTwitchChanged}
                    />
                </div>
            ),
        },
    ];

    return (
        <div className={sharedStyles.section}>
            <h2 className={sharedStyles.sectionTitle}>Интеграции</h2>
            <div className={styles.summaryRow}>
                <div className={styles.summaryItem}>
                    <span
                        className={`${styles.dot} ${
                            steamStatus?.connected ? styles.dotOn : styles.dotOff
                        }`}
                    />
                    <span className={styles.summaryLabel}>Steam</span>
                    <span className={styles.summaryValue}>{steamSummary}</span>
                </div>
                <div className={styles.summaryItem}>
                    <span className={`${styles.dot} ${twitchStatus?.connected ? styles.dotOn : styles.dotOff}`} />
                    <span className={styles.summaryLabel}>Twitch</span>
                    <span className={styles.summaryValue}>
                        {twitchLoading ? "Загрузка…" : twitchStatus?.connected ? twitchStatus.displayName : "Не подключён"}
                    </span>
                </div>
                <div className={styles.summaryItem}>
                    <span
                        className={`${styles.dot} ${
                            companion?.isOnline ? styles.dotOn : styles.dotOff
                        }`}
                    />
                    <span className={styles.summaryLabel}>Companion</span>
                    <span className={styles.summaryValue}>{companionSummary}</span>
                </div>
            </div>

            <Collapse
                className={styles.manageCollapse}
                items={items}
                defaultActiveKey={[]}
                ghost
            />
        </div>
    );
};
