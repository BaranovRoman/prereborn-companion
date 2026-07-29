import { streamApiClient } from "@/entities/stream-user/api/stream-client";
import type { QueueSettings } from "../model/types";

export const streamQueueSettingsApi = {
    get: async (): Promise<QueueSettings> => {
        const { data } = await streamApiClient.get<QueueSettings>("/account/me/queue-settings");
        return data;
    },
    save: async (settings: QueueSettings): Promise<QueueSettings> => {
        const { data } = await streamApiClient.put<QueueSettings>(
            "/account/me/queue-settings",
            settings
        );
        return data;
    },
};
