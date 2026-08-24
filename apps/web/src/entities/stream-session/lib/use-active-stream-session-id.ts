"use client";

import { useEffect, useState } from "react";
import { streamSessionApi } from "../api/stream-session";

// WK-84/WK-53: id "текущей" stream-сессии для visual-различения Recent Games
// там, где показывается account-wide история (см. use-account-matches.ts
// рядом - тот же однократный fetch без поллинга: список матчей в этих местах
// и так не живёт в реальном времени, granular reactivity не нужна). Намеренно
// берём session.id и для state === "active", И для state === "ended" (не
// только "active") - сразу после "Завершить стрим" матчи только что
// закончившегося стрима должны ОСТАВАТЬСЯ неприглушёнными, они становятся
// "previous" только когда реально стартует новая сессия (см. задачу: "после
// новой session они становятся previous"). Только state === "none" (ошибка
// или аккаунт вообще без единой сессии) даёт null - isMatchFromCurrentSession
// трактует это как "нечего различать".
export const useActiveStreamSessionId = () => {
    const [activeSessionId, setActiveSessionId] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;
        streamSessionApi
            .get()
            .then((response) => {
                if (!cancelled) setActiveSessionId(response.session?.id ?? null);
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
