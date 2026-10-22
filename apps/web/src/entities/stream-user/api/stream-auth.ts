import { streamApiClient } from "./stream-client";
import { clearStreamTokens, getStreamRefreshToken, setStreamTokens } from "../lib/tokens";
import { notifySessionChanged } from "../lib/session-events";
import type { AccountUser, StreamAuthResponse, StreamUser } from "../model/types";

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
        notifySessionChanged();
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
        notifySessionChanged();
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

    // WK-189 - revokes the refresh token server-side, then always clears the
    // local session and tells every mounted header/page about it.
    logout: async (): Promise<void> => {
        const refreshToken = getStreamRefreshToken();
        if (refreshToken) {
            await streamApiClient.post("/auth/logout", { refreshToken }).catch(() => {
                // Токен уже мог быть отозван/истёк - локальный logout всё равно
                // должен пройти, поэтому ошибку сети/сервера здесь не пробрасываем.
            });
        }
        clearStreamTokens();
        notifySessionChanged();
    },

    getMe: async (): Promise<AccountUser> => {
        const { data } = await streamApiClient.get<AccountUser>(
            "/account/me"
        );
        return data;
    },

    // WK-192 - irreversible: the server re-checks the password, then deletes
    // the account with all its data. The caller ends the local session with
    // endLocalSession() once it has decided where to navigate.
    deleteAccount: async (password: string): Promise<void> => {
        await streamApiClient.delete("/account/me", { data: { password } });
    },

    // Drops the local session without a server call (the account and its
    // refresh tokens are already gone server-side).
    endLocalSession: (): void => {
        clearStreamTokens();
        notifySessionChanged();
    },

    // WK-189 - revokes the legacy static Companion token (no new one is
    // issued: the current Companion signs in with email and password).
    revokeCompanionToken: async (): Promise<StreamUser> => {
        const { data } = await streamApiClient.delete<StreamUser>(
            "/account/me/companion-token"
        );
        return data;
    },
};
