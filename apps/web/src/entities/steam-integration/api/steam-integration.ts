import { streamApiClient } from "@/entities/stream-user/api/stream-client";
import type { DotaSyncResult, SteamIntegrationStatus } from "../model/types";

export const steamIntegrationApi = {
    getStatus: async (): Promise<SteamIntegrationStatus> => {
        const { data } = await streamApiClient.get<SteamIntegrationStatus>(
            "/integrations/steam"
        );
        return data;
    },

    // Двухшаговый redirect: обычная браузерная навигация (<a>/window.location)
    // не несёт наш Authorization-заголовок, поэтому сначала авторизованным
    // fetch получаем готовый URL Steam, и только потом переходим на него.
    connect: async (): Promise<void> => {
        const { data } = await streamApiClient.get<{ redirectUrl: string }>(
            "/integrations/steam/connect"
        );
        window.location.href = data.redirectUrl;
    },

    disconnect: async (): Promise<void> => {
        await streamApiClient.delete("/integrations/steam");
    },

    sync: async (): Promise<DotaSyncResult> => {
        const { data } = await streamApiClient.post<DotaSyncResult>(
            "/integrations/dota/sync"
        );
        return data;
    },
};
