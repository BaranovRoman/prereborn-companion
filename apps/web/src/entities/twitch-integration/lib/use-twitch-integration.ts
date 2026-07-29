"use client";

import { useCallback, useEffect, useState } from "react";
import { twitchIntegrationApi } from "../api/twitch-integration";
import type { TwitchIntegrationStatus } from "../model/types";

export const useTwitchIntegration = () => {
    const [status, setStatus] = useState<TwitchIntegrationStatus | null>(null);
    const [loading, setLoading] = useState(true);
    const refresh = useCallback(async () => {
        try {
            setStatus(await twitchIntegrationApi.getStatus());
        } finally {
            setLoading(false);
        }
    }, []);
    useEffect(() => { void refresh(); }, [refresh]);
    return { status, loading, refresh };
};
