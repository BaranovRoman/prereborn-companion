"use client";

import { useEffect, useState } from "react";
import { streamAuthApi } from "../api/stream-auth";
import { clearStreamTokens } from "./tokens";
import type { StreamUser } from "../model/types";

interface StreamSessionState {
    user: StreamUser | null;
    // undefined - ещё не проверяли, true - идёт проверка, false - готово
    loading: boolean;
}

// Нет фонового silent-refresh на каждый 401 (см. TTL-комментарий в
// stream-user-service.ts на бэкенде) - только одна попытка refresh при
// монтировании страницы, если access-токен уже истёк. Этого достаточно для
// единственной защищённой страницы этой итерации (/stream).
export const useStreamSession = () => {
    const [state, setState] = useState<StreamSessionState>({
        user: null,
        loading: true,
    });

    useEffect(() => {
        let cancelled = false;

        const load = async () => {
            try {
                const user = await streamAuthApi.getMe();
                if (!cancelled) setState({ user, loading: false });
                return;
            } catch {
                // access-токен отсутствует/истёк - пробуем обновить его
            }

            const refreshed = await streamAuthApi.refresh();
            if (!refreshed) {
                clearStreamTokens();
                if (!cancelled) setState({ user: null, loading: false });
                return;
            }

            try {
                const user = await streamAuthApi.getMe();
                if (!cancelled) setState({ user, loading: false });
            } catch {
                clearStreamTokens();
                if (!cancelled) setState({ user: null, loading: false });
            }
        };

        load();

        return () => {
            cancelled = true;
        };
    }, []);

    return state;
};
