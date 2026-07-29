"use client";

import { useCallback, useEffect, useState } from "react";
import { streamQueueSettingsApi } from "../api/stream-queue-settings";
import {
    DEFAULT_QUEUE_SETTINGS,
    type QueueSettings,
} from "../model/types";

export const useQueueSettings = () => {
    const [settings, setSettings] = useState<QueueSettings>(DEFAULT_QUEUE_SETTINGS);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        let cancelled = false;
        streamQueueSettingsApi
            .get()
            .then((value) => {
                if (!cancelled) {
                    setSettings({
                        ...DEFAULT_QUEUE_SETTINGS,
                        ...value,
                        visibility: {
                            ...DEFAULT_QUEUE_SETTINGS.visibility,
                            ...value.visibility,
                        },
                        favoriteHeroIds: value.favoriteHeroIds ?? [],
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

    const save = useCallback(async (next: QueueSettings) => {
        const previous = settings;
        setSettings(next);
        try {
            const saved = await streamQueueSettingsApi.save(next);
            const normalized = {
                ...DEFAULT_QUEUE_SETTINGS,
                ...saved,
                favoriteHeroIds: saved.favoriteHeroIds ?? [],
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
