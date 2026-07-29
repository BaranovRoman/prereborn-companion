import { streamApiClient } from "@/entities/stream-user/api/stream-client";
import type { TwitchIntegrationStatus } from "../model/types";

export const twitchIntegrationApi = {
    getStatus: async () => {
        const { data } = await streamApiClient.get<TwitchIntegrationStatus>("/integrations/twitch");
        return data;
    },
    connect: async () => {
        const { data } = await streamApiClient.get<{ redirectUrl: string }>("/integrations/twitch/connect");
        window.location.href = data.redirectUrl;
    },
    disconnect: async () => {
        await streamApiClient.delete("/integrations/twitch");
    },
};
