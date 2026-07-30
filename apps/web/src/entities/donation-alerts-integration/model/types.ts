export interface DonationAlertsDonation {
    id: number;
    username: string;
    message: string;
    amount: number;
    currency: string;
    createdAt: string;
}

export interface DonationAlertsIntegrationStatus {
    connected: boolean;
    configured: boolean;
    code?: string;
    displayName?: string;
    avatarUrl?: string | null;
    connectedAt?: string;
    donations: DonationAlertsDonation[];
    topDonors?: Array<{
        username: string;
        amount: number;
        currency: string;
        donationCount: number;
    }>;
}
