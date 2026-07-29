// Отдельные ключи localStorage от shared/api/client.ts ("token") - сервис
// стрим-оверлеев не должен делить хранилище токена с будущей авторизацией
// основного сайта, даже случайно.
const ACCESS_TOKEN_KEY = "stream_access_token";
const REFRESH_TOKEN_KEY = "stream_refresh_token";

export const getStreamAccessToken = (): string | null => {
    if (typeof window === "undefined") return null;
    return localStorage.getItem(ACCESS_TOKEN_KEY);
};

export const getStreamRefreshToken = (): string | null => {
    if (typeof window === "undefined") return null;
    return localStorage.getItem(REFRESH_TOKEN_KEY);
};

export const setStreamTokens = (
    accessToken: string,
    refreshToken: string
): void => {
    localStorage.setItem(ACCESS_TOKEN_KEY, accessToken);
    localStorage.setItem(REFRESH_TOKEN_KEY, refreshToken);
};

export const setStreamAccessToken = (accessToken: string): void => {
    localStorage.setItem(ACCESS_TOKEN_KEY, accessToken);
};

export const clearStreamTokens = (): void => {
    localStorage.removeItem(ACCESS_TOKEN_KEY);
    localStorage.removeItem(REFRESH_TOKEN_KEY);
};
