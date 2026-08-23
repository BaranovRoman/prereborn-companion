"use client";

import { useCallback, useEffect, useState } from "react";
import { streamViewerAlertsSettingsApi } from "../api/stream-viewer-alerts-settings";
import { DEFAULT_VIEWER_ALERTS_SETTINGS, type ViewerAlertsSettings } from "../model/types";

export const useViewerAlertsSettings = () => {
    const [settings, setSettings] = useState<ViewerAlertsSettings>(DEFAULT_VIEWER_ALERTS_SETTINGS);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        let cancelled = false;
        streamViewerAlertsSettingsApi
            .get()
            .then((value) => {
                if (!cancelled) {
                    setSettings({
                        ...DEFAULT_VIEWER_ALERTS_SETTINGS,
                        ...value,
                        types: { ...DEFAULT_VIEWER_ALERTS_SETTINGS.types, ...value.types },
                    });
                }
            })
            .finally(() => {
                if (!cancelled) setLoading(false);
            });
        return () => {
            cancelled = true;
        };
    }, []);

    const save = useCallback(async (next: ViewerAlertsSettings) => {
        const previous = settings;
        setSettings(next);
        try {
            const saved = await streamViewerAlertsSettingsApi.save(next);
            const normalized = {
                ...DEFAULT_VIEWER_ALERTS_SETTINGS,
                ...saved,
                types: { ...DEFAULT_VIEWER_ALERTS_SETTINGS.types, ...saved.types },
            };
            setSettings(normalized);
            return normalized;
        } catch (error) {
            setSettings(previous);
            throw error;
        }
    }, [settings]);

    return { settings, loading, save };
};
