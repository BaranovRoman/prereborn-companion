import { streamApiClient } from "@/entities/stream-user/api/stream-client";
import type {
    SessionLifecycleResponse,
    SessionSummary,
    StreamSession,
    StreamSessionPatch,
} from "../model/types";

export const streamSessionApi = {
    get: async (): Promise<SessionLifecycleResponse> => {
        const { data } = await streamApiClient.get<SessionLifecycleResponse>(
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

    // "Начать новый стрим" - работает из любого lifecycle state (active/
    // ended/none), см. backend resetActiveSession.
    reset: async (): Promise<StreamSession> => {
        const { data } = await streamApiClient.post<StreamSession>(
            "/account/session/reset"
        );
        return data;
    },

    // WK-53 - "Завершить стрим": идемпотентно (double-click safe, see
    // controllers/stream/session.ts) - always resolves with the ended
    // session + its summary, whether this call actually closed it or it was
    // already ended a moment ago.
    end: async (): Promise<{ session: StreamSession; summary: SessionSummary }> => {
        const { data } = await streamApiClient.post<{
            session: StreamSession;
            summary: SessionSummary;
        }>("/account/session/end");
        return data;
    },
};
