export interface AdminUserSummary {
    id: string;
    email: string;
    createdAt: string;
    onboardingCompletedAt: string | null;
    steamConnected: boolean;
    twitchConnected: boolean;
    twitchDisplayName: string | null;
    companionOnline: boolean;
    companionLastSeenAt: string | null;
    activeSessionStartedAt: string | null;
}

export interface AdminUserListResult {
    users: AdminUserSummary[];
    total: number;
    page: number;
    pageSize: number;
}

export interface AdminSteamLink {
    steamId64: string;
    dotaAccountId: number;
    connectedAt: string;
}

export interface AdminTwitchLink {
    login: string;
    displayName: string;
    connectedAt: string;
}

export interface AdminStreamSession {
    id: string;
    streamUserId: string;
    rating: number | null;
    wins: number;
    losses: number;
    lastHeroId: number | null;
    startedAt: string;
    endedAt: string | null;
    createdAt: string;
    updatedAt: string;
    lastSyncedAt: string | null;
    lastSyncStatus: string | null;
}

export interface AdminUserDetail {
    id: string;
    email: string;
    createdAt: string;
    onboardingCompletedAt: string | null;
    gameMode: "ranked" | "unranked";
    companionTokenConfigured: boolean;
    companionTokenCreatedAt: string | null;
    steam: AdminSteamLink | null;
    twitch: AdminTwitchLink | null;
    companion: {
        online: boolean;
        lastSeenAt: string | null;
        lastGsiReceivedAt: string | null;
        companionVersion: string | null;
    };
    latestSession: AdminStreamSession | null;
}
