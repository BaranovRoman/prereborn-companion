"use client";

import { useEffect, useState } from "react";
import { streamSessionApi } from "../api/stream-session";

// WK-84: id активной stream-сессии для visual-различения Recent Games там,
// где показывается account-wide история (см. use-account-matches.ts рядом -
// тот же однократный fetch без поллинга: список матчей в этих местах и так
// не живёт в реальном времени, granular reactivity не нужна). Ошибка
// (например неаутентифицированный публичный overlay-preview) молча остаётся
// null - isMatchFromCurrentSession трактует это как "нечего различать".
export const useActiveStreamSessionId = () => {
    const [activeSessionId, setActiveSessionId] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;
        streamSessionApi
            .get()
            .then((session) => {
                if (!cancelled) setActiveSessionId(session.id);
            })
            .catch(() => {
                // См. комментарий выше - тихо остаёмся без активной сессии.
            });
        return () => {
            cancelled = true;
        };
    }, []);

    return activeSessionId;
};
