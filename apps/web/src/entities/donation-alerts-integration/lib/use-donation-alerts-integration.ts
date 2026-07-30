"use client";

import { useCallback, useEffect, useState } from "react";
import { donationAlertsIntegrationApi } from "../api/donation-alerts-integration";
import type { DonationAlertsIntegrationStatus } from "../model/types";

export const useDonationAlertsIntegration = () => {
    const [status, setStatus] = useState<DonationAlertsIntegrationStatus | null>(null);
    const [loading, setLoading] = useState(true);
    const refresh = useCallback(async () => {
        try { setStatus(await donationAlertsIntegrationApi.getStatus()); }
        catch { setStatus(null); }
        finally { setLoading(false); }
    }, []);
    useEffect(() => {
        void refresh();
        const timer = window.setInterval(refresh, 15_000);
        return () => window.clearInterval(timer);
    }, [refresh]);
    return { status, loading, refresh };
};
