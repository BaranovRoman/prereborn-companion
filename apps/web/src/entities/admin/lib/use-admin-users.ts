"use client";

import { useEffect, useState } from "react";
import { adminUsersApi } from "../api/admin-users-api";
import type { AdminUserSummary } from "../model/types";

const PAGE_SIZE = 20;
// Не бьём API на каждое нажатие клавиши - ждём паузу в наборе (см. задачу:
// "search не спамит API на каждый keypress без разумного debounce").
const SEARCH_DEBOUNCE_MS = 350;

interface AdminUsersState {
    users: AdminUserSummary[];
    total: number;
    loading: boolean;
    error: string | null;
}

export const useAdminUsers = () => {
    const [rawQuery, setRawQuery] = useState("");
    const [debouncedQuery, setDebouncedQuery] = useState("");
    const [page, setPage] = useState(1);
    const [refreshToken, setRefreshToken] = useState(0);
    const [state, setState] = useState<AdminUsersState>({
        users: [],
        total: 0,
        loading: true,
        error: null,
    });

    useEffect(() => {
        const timer = setTimeout(() => setDebouncedQuery(rawQuery.trim()), SEARCH_DEBOUNCE_MS);
        return () => clearTimeout(timer);
    }, [rawQuery]);

    // Новый поиск всегда возвращает на первую страницу - иначе легко
    // оказаться на "странице 4" пустого результата после смены запроса.
    // Сбрасываем сразу в обработчике ввода (а не реактивно эффектом на
    // debouncedQuery) - React запрещает синхронный setState в теле эффекта
    // (react-hooks/set-state-in-effect), а сам сброс номера страницы не
    // требует ждать debounce: он не бьёт по API, в отличие от самого поиска.
    const setQuery = (value: string) => {
        setRawQuery(value);
        setPage(1);
    };

    // Только .then/.catch пишут в state (loading:false выставляется здесь
    // же) - без синхронного "loading:true" перед запросом, как и в
    // use-steam-integration.ts/use-twitch-integration.ts: таблица просто
    // заменяет данные, когда ответ приходит, без промежуточного мигания.
    useEffect(() => {
        let cancelled = false;

        adminUsersApi
            .list({ page, pageSize: PAGE_SIZE, query: debouncedQuery })
            .then((result) => {
                if (cancelled) return;
                setState({
                    users: result.users,
                    total: result.total,
                    loading: false,
                    error: null,
                });
            })
            .catch((error) => {
                if (cancelled) return;
                setState({
                    users: [],
                    total: 0,
                    loading: false,
                    error:
                        error?.response?.status === 403
                            ? "Доступ запрещён"
                            : "Не удалось загрузить список пользователей",
                });
            });

        return () => {
            cancelled = true;
        };
    }, [page, debouncedQuery, refreshToken]);

    return {
        ...state,
        query: rawQuery,
        setQuery,
        page,
        pageSize: PAGE_SIZE,
        setPage,
        refresh: () => setRefreshToken((token) => token + 1),
    };
};
