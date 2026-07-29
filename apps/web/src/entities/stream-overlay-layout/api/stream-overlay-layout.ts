import { streamApiClient } from "@/entities/stream-user/api/stream-client";
import type { OverlayLayout } from "../model/types";

export const streamOverlayLayoutApi = {
    get: async (): Promise<OverlayLayout> => {
        const { data } = await streamApiClient.get<OverlayLayout>(
            "/account/me/overlay-layout"
        );
        return data;
    },

    put: async (layout: OverlayLayout): Promise<OverlayLayout> => {
        const { data } = await streamApiClient.put<OverlayLayout>(
            "/account/me/overlay-layout",
            layout
        );
        return data;
    },
};
