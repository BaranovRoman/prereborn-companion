import type { TwitchViewerEvent, ViewerAlertsSettings } from "../model/types";

// WK-72 - the overlay poll re-sends the backend's whole bounded recent-events
// window every ~5s (same shape as chat.messages), not an incremental diff -
// so this queue has to do its own "have I already shown this id" tracking
// rather than trusting the array to only ever grow by one. seenIds is kept
// larger than the backend's own VIEWER_EVENT_LIMIT (20) so a slow/missed
// poll can never make an already-shown event look new again.
const SEEN_ID_LIMIT = 100;
// Caps how many alerts can be waiting to be shown - WK-72 explicitly calls
// out that a burst (e.g. a raid follow-train) must not grow the queue
// unboundedly. Oldest un-shown alerts are dropped first so the queue always
// stays close to "current", not stuck replaying a backlog from minutes ago.
const PENDING_LIMIT = 5;

export interface ViewerAlertQueueState {
    seenIds: readonly string[];
    pending: readonly TwitchViewerEvent[];
}

export const EMPTY_VIEWER_ALERT_QUEUE_STATE: ViewerAlertQueueState = { seenIds: [], pending: [] };

const isEnabled = (settings: ViewerAlertsSettings, event: TwitchViewerEvent) =>
    settings.enabled && settings.types[event.type];

// Folds a fresh poll result into the queue: marks every event as seen
// (so a redelivery on the next poll is a no-op), and enqueues only the
// ones that are both new AND enabled per current settings. Toggling a
// type off does not retroactively remove already-queued alerts of that
// type - it only stops new ones of that type from being queued.
export const reconcileViewerAlertQueue = (
    state: ViewerAlertQueueState,
    incomingEvents: readonly TwitchViewerEvent[],
    settings: ViewerAlertsSettings
): ViewerAlertQueueState => {
    const seen = new Set(state.seenIds);
    const newlySeenIds: string[] = [];
    const newlyPending: TwitchViewerEvent[] = [];
    for (const event of incomingEvents) {
        if (seen.has(event.id)) continue;
        seen.add(event.id);
        newlySeenIds.push(event.id);
        if (isEnabled(settings, event)) newlyPending.push(event);
    }
    if (newlySeenIds.length === 0) return state;
    return {
        seenIds: [...state.seenIds, ...newlySeenIds].slice(-SEEN_ID_LIMIT),
        pending: [...state.pending, ...newlyPending].slice(-PENDING_LIMIT),
    };
};

export interface DequeueResult {
    next: TwitchViewerEvent | null;
    state: ViewerAlertQueueState;
}

// Pops exactly one alert to display - the "sequential, non-overlapping"
// half of WK-72's requirement (the caller is expected to hold `next` on
// screen for a fixed duration, then dequeue again).
export const dequeueViewerAlert = (state: ViewerAlertQueueState): DequeueResult => {
    if (state.pending.length === 0) return { next: null, state };
    const [next, ...rest] = state.pending;
    return { next, state: { ...state, pending: rest } };
};
