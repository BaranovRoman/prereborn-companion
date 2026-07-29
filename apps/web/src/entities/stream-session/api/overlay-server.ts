import type { OverlayData } from "../model/types";

// Серверный доступ к публичному /overlay/:publicToken - используется только
// в Server Component app/overlay/[publicToken]/page.tsx для первого
// рендера. Тот же принцип, что и shared/api/server-client.ts: на сервере
// бьём напрямую в backend, а не через Next.js rewrites (те применяются
// только к входящим HTTP-запросам, а не к fetch изнутри Server Component).
// Дальнейшее обновление данных в браузере - через overlay-client.ts
// (поллинг), не через этот модуль.
const getBaseURL = (): string =>
    process.env.NEXT_PUBLIC_API_URL ||
    process.env.API_URL ||
    "http://127.0.0.1:3001/api";

export const getOverlayData = async (
    publicToken: string
): Promise<OverlayData | null> => {
    try {
        const response = await fetch(
            `${getBaseURL()}/stream/overlay/${encodeURIComponent(publicToken)}`,
            { cache: "no-store" }
        );

        if (!response.ok) return null;
        return (await response.json()) as OverlayData;
    } catch {
        return null;
    }
};
