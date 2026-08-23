"use client";

import { useEffect, useRef, useState } from "react";
import {
    dequeueViewerAlert,
    EMPTY_VIEWER_ALERT_QUEUE_STATE,
    reconcileViewerAlertQueue,
    type ViewerAlertQueueState,
} from "./viewer-alert-queue";
import type { TwitchViewerEvent, ViewerAlertsSettings } from "../model/types";

// How long a single alert stays visible before the next one (if any) takes
// its place - the "sequential, non-overlapping" half of WK-72. Kept as a
// simple fixed duration rather than per-type timing: nothing in the ticket
// asks for per-type display time, and a single constant is one less thing
// to keep in sync between here and the widget's own exit animation.
const ALERT_DISPLAY_MS = 6000;

// Consumes whatever the overlay poll's `viewerEvents` array currently holds
// (see use-overlay-polling.ts) and turns it into "one alert on screen at a
// time" - reconciliation (dedup + settings filtering + bounding) is pure
// (viewer-alert-queue.ts, fully unit tested); this hook is just the timer
// glue on top, which is why it isn't itself unit tested beyond that core.
export const useViewerAlertQueue = (
    viewerEvents: TwitchViewerEvent[],
    settings: ViewerAlertsSettings
) => {
    const queueRef = useRef<ViewerAlertQueueState>(EMPTY_VIEWER_ALERT_QUEUE_STATE);
    const [current, setCurrent] = useState<TwitchViewerEvent | null>(null);
    const advancingRef = useRef(false);

    useEffect(() => {
        queueRef.current = reconcileViewerAlertQueue(queueRef.current, viewerEvents, settings);
    }, [viewerEvents, settings]);

    useEffect(() => {
        const advance = () => {
            if (advancingRef.current) return;
            if (current !== null) return;
            const { next, state } = dequeueViewerAlert(queueRef.current);
            queueRef.current = state;
            if (next) setCurrent(next);
        };
        const interval = setInterval(advance, 500);
        advance();
        return () => clearInterval(interval);
    }, [current]);

    useEffect(() => {
        if (current === null) return;
        advancingRef.current = true;
        const timeout = setTimeout(() => {
            advancingRef.current = false;
            setCurrent(null);
        }, ALERT_DISPLAY_MS);
        return () => clearTimeout(timeout);
    }, [current]);

    return current;
};
