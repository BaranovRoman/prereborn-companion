// WK-72 - mirrors the backend union in
// apps/api/src/services/twitch-eventsub-chat.ts (TwitchViewerEvent). Kept in
// sync by hand (same as TwitchIntegrationStatus above it) rather than a
// shared package - this repo doesn't share types across apps/api and
// apps/web today.
export type TwitchViewerEvent =
    | { id: string; type: "follow"; userName: string; userLogin: string | null; receivedAt: string }
    | { id: string; type: "subscribe"; userName: string; userLogin: string | null; tier: string; isGift: boolean; receivedAt: string }
    | { id: string; type: "giftSub"; userName: string | null; userLogin: string | null; tier: string; count: number; isAnonymous: boolean; receivedAt: string }
    | { id: string; type: "raid"; userName: string; userLogin: string | null; viewerCount: number; receivedAt: string };

export interface ViewerAlertsSettings {
    enabled: boolean;
    types: {
        follow: boolean;
        subscribe: boolean;
        giftSub: boolean;
        raid: boolean;
    };
}

export const DEFAULT_VIEWER_ALERTS_SETTINGS: ViewerAlertsSettings = {
    enabled: true,
    types: { follow: true, subscribe: true, giftSub: true, raid: true },
};
