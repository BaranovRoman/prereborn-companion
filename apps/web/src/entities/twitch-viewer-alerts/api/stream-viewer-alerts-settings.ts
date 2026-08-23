import { streamApiClient } from "@/entities/stream-user/api/stream-client";
import type { ViewerAlertsSettings } from "../model/types";

export const streamViewerAlertsSettingsApi = {
    get: async (): Promise<ViewerAlertsSettings> => {
        const { data } = await streamApiClient.get<ViewerAlertsSettings>("/account/me/viewer-alerts-settings");
        return data;
    },
    save: async (settings: ViewerAlertsSettings): Promise<ViewerAlertsSettings> => {
        const { data } = await streamApiClient.put<ViewerAlertsSettings>(
            "/account/me/viewer-alerts-settings",
            settings
        );
        return data;
    },
};
