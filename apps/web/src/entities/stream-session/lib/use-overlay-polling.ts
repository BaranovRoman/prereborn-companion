"use client";

import { useEffect, useState } from "react";
import { fetchOverlayData } from "../api/overlay-client";
import type { OverlayData } from "../model/types";

const POLL_INTERVAL_MS = 5000;

// Следующий опрос планируется только после того, как предыдущий fetch
// полностью завершился (setTimeout, а не setInterval) - параллельные
// запросы структурно невозможны, даже если сеть на секунду задержит ответ
// дольше 5с. На сетевой/5xx-ошибке fetchOverlayData возвращает null - в
// этом случае просто не трогаем data, HUD не мигает и не очищается.
export const useOverlayPolling = (
    publicToken: string,
    initialData: OverlayData | null,
    refreshToken = 0
): OverlayData | null => {
    const [data, setData] = useState<OverlayData | null>(initialData);

    useEffect(() => {
        let cancelled = false;
        let timeoutId: ReturnType<typeof setTimeout>;

        const poll = async () => {
            const result = await fetchOverlayData(publicToken);
            if (!cancelled) {
                if (result) setData(result);
                timeoutId = setTimeout(poll, POLL_INTERVAL_MS);
            }
        };

        void poll();

        return () => {
            cancelled = true;
            clearTimeout(timeoutId);
        };
    }, [publicToken, refreshToken]);

    return data;
};
