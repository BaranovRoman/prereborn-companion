import axios, { AxiosError, InternalAxiosRequestConfig } from "axios";
import {
    clearStreamTokens,
    getStreamAccessToken,
    getStreamRefreshToken,
    setStreamTokens,
} from "../lib/tokens";

// Отдельный axios-инстанс от shared/api/client.ts - своя baseURL и свой
// источник токена (lib/tokens.ts), полностью изолирован от apiClient,
// который обслуживает остальной сайт.
export const streamApiClient = axios.create({
    baseURL: "/api/stream",
    headers: {
        "Content-Type": "application/json",
    },
    timeout: 10000,
});

streamApiClient.interceptors.request.use((config) => {
    const token = getStreamAccessToken();
    if (token) {
        config.headers.Authorization = `Bearer ${token}`;
    }
    // Для FormData не оставляем дефолтный Content-Type: application/json -
    // иначе axios не подставит multipart-boundary и сервер не распарсит тело.
    if (config.data instanceof FormData && config.headers["Content-Type"] === "application/json") {
        delete config.headers["Content-Type"];
    }
    return config;
});

interface RetriableConfig extends InternalAxiosRequestConfig {
    _streamRetried?: boolean;
}

let refreshPromise: Promise<string | null> | null = null;

// Один запрос на refresh, даже если несколько вызовов словили 401
// одновременно (например, две панели настроек дёрнули API почти в один
// момент) - без этого каждый из них ротировал бы refresh-токен независимо,
// и второй запрос получил бы уже невалидный (отозванный первой ротацией)
// refresh-токен.
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

// Access-токен живёт 1ч (ACCESS_TOKEN_TTL, backend/stream-user-service.ts),
// а /stream - единственная защищённая страница без фонового silent-refresh
// (useStreamSession пробует refresh только один раз, при монтировании
// страницы). Если вкладка простояла открытой дольше часа и пользователь
// затем нажал защищённое действие (например, "Создать токен" в
// CompanionPanel), первый же запрос без этого перехватчика словил бы 401,
// а UI показал бы общую "не удалось..." ошибку, хотя причина - истёкший
// access-токен, который тривиально обновляется по refresh-токену. Здесь -
// одна попытка refresh + один повтор исходного запроса (_streamRetried
// защищает от зацикливания, если и refresh-токен уже недействителен).
streamApiClient.interceptors.response.use(
    (response) => response,
    async (error: AxiosError) => {
        const config = error.config as RetriableConfig | undefined;
        const isAuthEndpoint = config?.url?.startsWith("/auth/");

        if (
            error.response?.status === 401 &&
            config &&
            !config._streamRetried &&
            !isAuthEndpoint
        ) {
            config._streamRetried = true;
            const newAccessToken = await refreshAccessToken();
            if (newAccessToken) {
                config.headers.Authorization = `Bearer ${newAccessToken}`;
                return streamApiClient(config);
            }
            clearStreamTokens();
        }

        return Promise.reject(error);
    }
);
