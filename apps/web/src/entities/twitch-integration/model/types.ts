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
    chat: {
        connected: boolean;
        messages: Array<{
            id: string;
            author: string;
            color: string | null;
            text: string;
            badges: string[];
            receivedAt: string;
        }>;
    };
    recentSubscribers: Array<{
        id: string;
        name: string;
        tier: string;
        isGift: boolean;
        receivedAt: string;
    }>;
}
