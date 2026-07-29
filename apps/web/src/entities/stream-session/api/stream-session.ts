import { streamApiClient } from "@/entities/stream-user/api/stream-client";
import type { StreamSession, StreamSessionPatch } from "../model/types";

export const streamSessionApi = {
    get: async (): Promise<StreamSession> => {
        const { data } = await streamApiClient.get<StreamSession>(
            "/account/session"
        );
        return data;
    },

    patch: async (patch: StreamSessionPatch): Promise<StreamSession> => {
        const { data } = await streamApiClient.patch<StreamSession>(
            "/account/session",
            patch
        );
        return data;
    },

    reset: async (): Promise<StreamSession> => {
        const { data } = await streamApiClient.post<StreamSession>(
            "/account/session/reset"
        );
        return data;
    },
};
