export interface TwitchIntegrationStatus {
    connected: boolean;
    configured: boolean;
    login?: string;
    displayName?: string;
    profileImageUrl?: string | null;
    connectedAt?: string;
    live?: {
        title: string;
        viewerCount: number;
        gameName: string;
    } | null;
}
