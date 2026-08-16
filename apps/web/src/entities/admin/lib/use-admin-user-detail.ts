"use client";

import { useEffect, useState } from "react";
import { adminUsersApi } from "../api/admin-users-api";
import type { AdminUserDetail } from "../model/types";

interface AdminUserDetailState {
    detail: AdminUserDetail | null;
    loading: boolean;
    // 403/404 различаются, чтобы страница могла показать разный текст
    // ("доступ запрещён" против "пользователь не найден").
    errorStatus: number | null;
}

export const useAdminUserDetail = (id: string) => {
    const [state, setState] = useState<AdminUserDetailState>({
        detail: null,
        loading: true,
        errorStatus: null,
    });
    const [refreshToken, setRefreshToken] = useState(0);

    // Только .then/.catch пишут в state - без синхронного "loading:true" в
    // начале эффекта (react-hooks/set-state-in-effect), как и в остальных
    // hand-rolled data-хуках проекта (use-steam-integration.ts и т.д.).
    useEffect(() => {
        let cancelled = false;

        adminUsersApi
            .getById(id)
            .then((detail) => {
                if (!cancelled) setState({ detail, loading: false, errorStatus: null });
            })
            .catch((error) => {
                if (!cancelled) {
                    setState({
                        detail: null,
                        loading: false,
                        errorStatus: error?.response?.status ?? 500,
                    });
                }
            });

        return () => {
            cancelled = true;
        };
    }, [id, refreshToken]);

    return { ...state, refresh: () => setRefreshToken((token) => token + 1) };
};
