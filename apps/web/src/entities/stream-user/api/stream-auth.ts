import { streamApiClient } from "./stream-client";
import { getStreamRefreshToken, setStreamTokens } from "../lib/tokens";
import type {
    RegenerateCompanionTokenResult,
    StreamAuthResponse,
    StreamGameMode,
    StreamUser,
} from "../model/types";

export const streamAuthApi = {
    register: async (
        email: string,
        password: string
    ): Promise<StreamAuthResponse> => {
        const { data } = await streamApiClient.post<StreamAuthResponse>(
            "/auth/register",
            { email, password }
        );
        setStreamTokens(data.accessToken, data.refreshToken);
        return data;
    },

    login: async (
        email: string,
        password: string
    ): Promise<StreamAuthResponse> => {
        const { data } = await streamApiClient.post<StreamAuthResponse>(
            "/auth/login",
            { email, password }
        );
        setStreamTokens(data.accessToken, data.refreshToken);
        return data;
    },

    // Возвращает false, если refresh-токена нет или он недействителен -
    // вызывающий код (useStreamSession) в этом случае отправляет на /stream/login.
    refresh: async (): Promise<boolean> => {
        const refreshToken = getStreamRefreshToken();
        if (!refreshToken) return false;

        try {
            const { data } = await streamApiClient.post<{
                accessToken: string;
                refreshToken: string;
            }>("/auth/refresh", { refreshToken });
            setStreamTokens(data.accessToken, data.refreshToken);
            return true;
        } catch {
            return false;
        }
    },

    logout: async (): Promise<void> => {
        const refreshToken = getStreamRefreshToken();
        if (!refreshToken) return;
        await streamApiClient.post("/auth/logout", { refreshToken }).catch(() => {
            // Токен уже мог быть отозван/истёк - локальный logout всё равно
            // должен пройти, поэтому ошибку сети/сервера здесь не пробрасываем.
        });
    },

    getMe: async (): Promise<StreamUser> => {
        const { data } = await streamApiClient.get<StreamUser>(
            "/account/me"
        );
        return data;
    },

    regenerateToken: async (): Promise<StreamUser> => {
        const { data } = await streamApiClient.post<StreamUser>(
            "/account/me/regenerate-token"
        );
        return data;
    },

    setGameMode: async (gameMode: StreamGameMode): Promise<StreamUser> => {
        const { data } = await streamApiClient.patch<StreamUser>(
            "/account/me/game-mode",
            { gameMode }
        );
        return data;
    },

    // Возвращает сырой companion-токен - показывается пользователю ровно
    // один раз (companion-panel.tsx), дальше нигде не хранится и не
    // запрашивается заново (backend его и не может отдать повторно - хранит
    // только хэш).
    regenerateCompanionToken: async (): Promise<RegenerateCompanionTokenResult> => {
        const { data } = await streamApiClient.post<RegenerateCompanionTokenResult>(
            "/account/me/companion-token/regenerate"
        );
        return data;
    },
};
