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
                if (!cancelled) setSettings(value);
            })
            .finally(() => {
                if (!cancelled) setLoading(false);
            });
        return () => {
            cancelled = true;
        };
    }, []);

    const save = useCallback(async (next: QueueSettings) => {
        setSettings(next);
        const saved = await streamQueueSettingsApi.save(next);
        setSettings(saved);
        return saved;
    }, []);

    return { settings, loading, save };
};
