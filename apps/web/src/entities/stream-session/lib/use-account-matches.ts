"use client";

import { useEffect, useState } from "react";
import { streamMatchesApi } from "../api/stream-matches";
import type { AccountStreamMatch } from "../model/types";

// Вынесено из match-history-panel.tsx без изменения логики - список нужен
// одновременно карточке "Последний матч" (matches[0]) и карточке "Последние
// матчи"/"Полная история" (весь список), обе теперь в разных ячейках грида
// дашборда, поэтому фетч поднят на уровень страницы, чтобы не дублировать
// запрос .../account/me/matches.
export const useAccountMatches = () => {
    const [matches, setMatches] = useState<AccountStreamMatch[] | null>(null);

    useEffect(() => {
        let cancelled = false;
        streamMatchesApi
            .list()
            .then((loaded) => {
                if (!cancelled) setMatches(loaded);
            })
            .catch(() => {
                if (!cancelled) setMatches([]);
            });
        return () => {
            cancelled = true;
        };
    }, []);

    const handleUpdated = async (updated: AccountStreamMatch) => {
        setMatches((current) =>
            current
                ? current.map((match) => (match.id === updated.id ? updated : match))
                : current
        );
        try {
            setMatches(await streamMatchesApi.list());
        } catch {
            // Оптимистично обновлённая строка остаётся видимой; следующий
            // вход/рефетч восстановит полный каскад, если сеть недоступна.
        }
    };

    return { matches, handleUpdated };
};
