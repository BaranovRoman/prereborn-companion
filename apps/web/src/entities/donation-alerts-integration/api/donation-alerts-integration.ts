import { streamApiClient } from "@/entities/stream-user/api/stream-client";
import type { DonationAlertsIntegrationStatus } from "../model/types";

export const donationAlertsIntegrationApi = {
    getStatus: async () => {
        const { data } = await streamApiClient.get<DonationAlertsIntegrationStatus>(
            "/integrations/donation-alerts",
            {
                params: { _: Date.now() },
                headers: { "Cache-Control": "no-cache" },
            }
        );
        return data;
    },
    connect: async () => {
        const { data } = await streamApiClient.get<{ redirectUrl: string }>("/integrations/donation-alerts/connect");
        window.location.assign(data.redirectUrl);
    },
    disconnect: async () => {
        await streamApiClient.delete("/integrations/donation-alerts");
    },
};
