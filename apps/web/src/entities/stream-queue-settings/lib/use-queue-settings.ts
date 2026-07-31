"use client";

import { useCallback, useEffect, useState } from "react";
import { streamQueueSettingsApi } from "../api/stream-queue-settings";
import {
    DEFAULT_QUEUE_SETTINGS,
    DEFAULT_QUEUE_WIDGET_SETTINGS,
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
                        webcamImageUrl: value.webcamImageUrl ?? null,
                        channelGoal: {
                            ...DEFAULT_QUEUE_SETTINGS.channelGoal,
                            ...value.channelGoal,
                        },
                        widgets: {
                            ...DEFAULT_QUEUE_WIDGET_SETTINGS,
                            ...value.widgets,
                            titles: {
                                ...DEFAULT_QUEUE_WIDGET_SETTINGS.titles,
                                ...value.widgets?.titles,
                            },
                            friends: {
                                ...DEFAULT_QUEUE_WIDGET_SETTINGS.friends,
                                ...value.widgets?.friends,
                                socialLinks: value.widgets?.friends?.socialLinks ?? [],
                            },
                        },
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
                webcamImageUrl: saved.webcamImageUrl ?? null,
                channelGoal: {
                    ...DEFAULT_QUEUE_SETTINGS.channelGoal,
                    ...saved.channelGoal,
                },
                widgets: {
                    ...DEFAULT_QUEUE_WIDGET_SETTINGS,
                    ...saved.widgets,
                    titles: {
                        ...DEFAULT_QUEUE_WIDGET_SETTINGS.titles,
                        ...saved.widgets?.titles,
                    },
                    friends: {
                        ...DEFAULT_QUEUE_WIDGET_SETTINGS.friends,
                        ...saved.widgets?.friends,
                        socialLinks: saved.widgets?.friends?.socialLinks ?? [],
                    },
                },
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
