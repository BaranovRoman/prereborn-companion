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
    // WK-189 - Companion heartbeat activity (WK-186 definitions).
    lastCompanionActivityAt: string | null;
    activeDays30d: number;
    legacyTokenConfigured: boolean;
    isAdmin: boolean;
}

export type AdminUserSort = "created_desc" | "created_asc" | "activity_desc" | "email_asc";

// GET /api/admin/usage-stats (WK-186), the fields the users screen shows.
export interface AdminUsageStats {
    registeredUsers: number;
    dau: number;
    wau: number;
    mau: number;
    trackingSince: string | null;
    generatedAt: string;
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
