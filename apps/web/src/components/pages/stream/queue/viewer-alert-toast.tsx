"use client";

import { useViewerAlertQueue } from "@/entities/twitch-viewer-alerts/lib/use-viewer-alert-queue";
import { DEFAULT_VIEWER_ALERTS_SETTINGS, type TwitchViewerEvent, type ViewerAlertsSettings } from "@/entities/twitch-viewer-alerts/model/types";
import styles from "./viewer-alert-toast.module.scss";

const describe = (event: TwitchViewerEvent): { icon: string; name: string; detail: string } => {
    switch (event.type) {
        case "follow":
            return { icon: "❤", name: event.userName, detail: "подписался на канал" };
        case "subscribe":
            return { icon: "★", name: event.userName, detail: event.isGift ? "получил подписку в подарок" : "оформил подписку" };
        case "giftSub":
            return {
                icon: "🎁",
                name: event.isAnonymous || !event.userName ? "Аноним" : event.userName,
                detail: event.count > 1 ? `подарил ${event.count} подписок` : "подарил подписку",
            };
        case "raid":
            return { icon: "⚡", name: event.userName, detail: `рейд, ${event.viewerCount} зрителей` };
    }
};

interface Props {
    viewerEvents?: TwitchViewerEvent[];
    viewerAlertsSettings?: ViewerAlertsSettings;
}

// WK-72 - one alert at a time, top-right corner of the public overlay
// (queue-scene-ui.tsx mounts this at the top level, see QueueSceneUi). All
// queueing/dedup/settings-filtering logic lives in
// entities/twitch-viewer-alerts (unit tested) - this component only ever
// renders whatever useViewerAlertQueue currently says is "current".
export const ViewerAlertToast = ({ viewerEvents, viewerAlertsSettings }: Props) => {
    const current = useViewerAlertQueue(viewerEvents ?? [], viewerAlertsSettings ?? DEFAULT_VIEWER_ALERTS_SETTINGS);
    if (!current) return null;
    const { icon, name, detail } = describe(current);
    return (
        <div className={styles.toast} data-testid="viewer-alert-toast" data-alert-type={current.type}>
            <span className={styles.icon} aria-hidden="true">{icon}</span>
            <span>
                <span className={styles.name}>{name}</span>{" "}
                <span className={styles.detail}>{detail}</span>
            </span>
        </div>
    );
};
