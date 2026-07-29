export type DotaSyncStatus =
    | "ok"
    | "skipped_cooldown"
    | "skipped_in_progress"
    | "steam_not_connected"
    | "not_found"
    | "rate_limited"
    | "unavailable";

export interface SteamIntegrationStatus {
    connected: boolean;
    steamId64?: string;
    connectedAt?: string;
    lastSyncedAt?: string | null;
    lastSyncStatus?: DotaSyncStatus | null;
}

export interface DotaSyncResult {
    status: DotaSyncStatus;
    processedMatches: number;
    winsAdded: number;
    lossesAdded: number;
    lastHeroId: number | null;
    syncedAt: string | null;
}
