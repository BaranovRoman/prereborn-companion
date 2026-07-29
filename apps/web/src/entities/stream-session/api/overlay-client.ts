import type { OverlayData } from "../model/types";

// Клиентский поллинг того же публичного /overlay/:publicToken - относительный
// путь "/api/..." идёт через Next.js rewrites (next.config.js), тот же
// паттерн, что и shared/api/client.ts. Без авторизации - endpoint публичный.
export const fetchOverlayData = async (
    publicToken: string
): Promise<OverlayData | null> => {
    try {
        const response = await fetch(
            `/api/stream/overlay/${encodeURIComponent(publicToken)}`,
            { cache: "no-store" }
        );
        if (!response.ok) return null;
        return (await response.json()) as OverlayData;
    } catch {
        return null;
    }
};
