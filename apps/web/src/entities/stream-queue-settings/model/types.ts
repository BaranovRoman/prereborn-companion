export type QueueWidgetId =
    | "playerProfile"
    | "streamProfile"
    | "featuredMatch"
    | "webcam"
    | "favoriteHeroes"
    | "recentGames"
    | "twitchChat"
    | "systemStatus";

export interface QueueSettings {
    version: 1;
    visibility: Record<QueueWidgetId, boolean>;
}

export const DEFAULT_QUEUE_SETTINGS: QueueSettings = {
    version: 1,
    visibility: {
        playerProfile: true,
        streamProfile: true,
        featuredMatch: true,
        webcam: true,
        favoriteHeroes: true,
        recentGames: true,
        twitchChat: true,
        systemStatus: true,
    },
};
