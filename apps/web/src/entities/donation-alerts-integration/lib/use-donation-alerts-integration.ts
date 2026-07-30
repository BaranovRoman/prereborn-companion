"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { donationAlertsIntegrationApi } from "../api/donation-alerts-integration";
import type { DonationAlertsIntegrationStatus } from "../model/types";

export const useDonationAlertsIntegration = () => {
    const [status, setStatus] = useState<DonationAlertsIntegrationStatus | null>(null);
    const [loading, setLoading] = useState(true);
    const inFlight = useRef<Promise<void> | null>(null);
    const refresh = useCallback(() => {
        if (inFlight.current) return inFlight.current;
        const request = donationAlertsIntegrationApi.getStatus()
            .then(setStatus)
            .catch(() => setStatus(null))
            .finally(() => {
                setLoading(false);
                if (inFlight.current === request) inFlight.current = null;
            });
        inFlight.current = request;
        return request;
    }, []);
    useEffect(() => {
        let active = true;
        let timer: number | undefined;
        const poll = async () => {
            await refresh();
            if (active) timer = window.setTimeout(poll, 15_000);
        };
        const refreshWhenVisible = () => {
            if (document.visibilityState === "visible") void refresh();
        };
        void poll();
        window.addEventListener("focus", refreshWhenVisible);
        document.addEventListener("visibilitychange", refreshWhenVisible);
        return () => {
            active = false;
            if (timer !== undefined) window.clearTimeout(timer);
            window.removeEventListener("focus", refreshWhenVisible);
            document.removeEventListener("visibilitychange", refreshWhenVisible);
        };
    }, [refresh]);
    return { status, loading, refresh };
};
