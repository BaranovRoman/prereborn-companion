export type QueueWidgetId =
    | "playerProfile"
    | "streamProfile"
    | "featuredMatch"
    | "webcam"
    | "favoriteHeroes"
    | "recentGames"
    | "twitchChat"
    | "systemStatus";

export interface QueueChannelGoal {
    type: "none" | "rating" | "custom";
    label: string;
    startValue: number;
    targetValue: number;
}

export interface QueueSettings {
    version: 1;
    visibility: Record<QueueWidgetId, boolean>;
    favoriteHeroIds: number[];
    webcamImageUrl: string | null;
    channelGoal: QueueChannelGoal;
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
        systemStatus: false,
    },
    favoriteHeroIds: [],
    webcamImageUrl: null,
    channelGoal: {
        type: "none",
        label: "",
        startValue: 0,
        targetValue: 0,
    },
};
