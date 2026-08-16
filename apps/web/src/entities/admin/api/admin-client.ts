import axios, { AxiosError, InternalAxiosRequestConfig } from "axios";
import {
    getStreamAccessToken,
    getStreamRefreshToken,
    setStreamTokens,
} from "@/entities/stream-user/lib/tokens";

// Admin - не отдельная система входа: тот же JWT/refresh-токен, что и
// /api/stream/* (см. middleware/require-admin.ts на бэкенде), поэтому
// переиспользуем lib/tokens.ts, а не заводим отдельное хранилище.
export const adminApiClient = axios.create({
    baseURL: "/api/admin",
    headers: { "Content-Type": "application/json" },
    timeout: 10000,
});

adminApiClient.interceptors.request.use((config) => {
    const token = getStreamAccessToken();
    if (token) {
        config.headers.Authorization = `Bearer ${token}`;
    }
    return config;
});

interface RetriableConfig extends InternalAxiosRequestConfig {
    _adminRetried?: boolean;
}

let refreshPromise: Promise<string | null> | null = null;

const refreshAccessToken = async (): Promise<string | null> => {
    const refreshToken = getStreamRefreshToken();
    if (!refreshToken) return null;

    if (!refreshPromise) {
        refreshPromise = axios
            .post<{ accessToken: string; refreshToken: string }>(
                "/api/stream/auth/refresh",
                { refreshToken }
            )
            .then(({ data }) => {
                setStreamTokens(data.accessToken, data.refreshToken);
                return data.accessToken;
            })
            .catch(() => null)
            .finally(() => {
                refreshPromise = null;
            });
    }
    return refreshPromise;
};

// 401 (просроченный access-токен) пробуем восстановить один раз, как
// streamApiClient. 403 (не админ) - осознанный ответ backend, а не что-то
// исправимое повтором - оставляем странице показать "доступ запрещён".
adminApiClient.interceptors.response.use(
    (response) => response,
    async (error: AxiosError) => {
        const config = error.config as RetriableConfig | undefined;

        if (error.response?.status === 401 && config && !config._adminRetried) {
            config._adminRetried = true;
            const newAccessToken = await refreshAccessToken();
            if (newAccessToken) {
                config.headers.Authorization = `Bearer ${newAccessToken}`;
                return adminApiClient(config);
            }
        }

        return Promise.reject(error);
    }
);
