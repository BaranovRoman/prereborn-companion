"use client";

import { useEffect, useState } from "react";
import { streamAuthApi } from "../api/stream-auth";
import { clearStreamTokens, getStreamAccessToken, getStreamRefreshToken } from "./tokens";
import { subscribeToSessionChanges } from "./session-events";
import type { AccountUser } from "../model/types";

export type StreamSessionStatus = "checking" | "guest" | "user";

interface StreamSessionState {
    status: StreamSessionStatus;
    user: AccountUser | null;
}

// WK-189 - the one place the site decides "who is signed in": the public
// header, /account and /admin all use it. The session is client-only
// (localStorage tokens), so the server render is always "checking" and the
// real state arrives after hydration. Re-checks on login/logout in this tab
// and in other tabs (session-events.ts); an expired access token gets one
// refresh attempt, a dead refresh token means guest.
export const useStreamSession = () => {
    const [state, setState] = useState<StreamSessionState>({ status: "checking", user: null });

    useEffect(() => {
        let cancelled = false;
        let latest = 0;

        const load = async () => {
            const run = ++latest;
            const settle = (user: AccountUser | null) => {
                if (!cancelled && run === latest) {
                    setState(user ? { status: "user", user } : { status: "guest", user: null });
                }
            };

            if (!getStreamAccessToken() && !getStreamRefreshToken()) return settle(null);

            try {
                return settle(await streamAuthApi.getMe());
            } catch {
                // access-токен отсутствует/истёк - пробуем обновить его
            }

            if (await streamAuthApi.refresh()) {
                try {
                    return settle(await streamAuthApi.getMe());
                } catch {
                    // refresh succeeded but the account is gone - fall through
                }
            }
            clearStreamTokens();
            settle(null);
        };

        load();
        const unsubscribe = subscribeToSessionChanges(() => {
            load();
        });

        return () => {
            cancelled = true;
            unsubscribe();
        };
    }, []);

    return { ...state, loading: state.status === "checking" };
};
