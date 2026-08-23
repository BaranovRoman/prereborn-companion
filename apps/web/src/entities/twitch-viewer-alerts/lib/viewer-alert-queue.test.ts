import { describe, expect, it } from "vitest";
import {
    dequeueViewerAlert,
    EMPTY_VIEWER_ALERT_QUEUE_STATE,
    reconcileViewerAlertQueue,
} from "./viewer-alert-queue";
import { DEFAULT_VIEWER_ALERTS_SETTINGS, type TwitchViewerEvent } from "../model/types";

const follow = (id: string): TwitchViewerEvent => ({
    id,
    type: "follow",
    userName: `Viewer-${id}`,
    userLogin: null,
    receivedAt: "2026-08-23T00:00:00Z",
});

describe("reconcileViewerAlertQueue", () => {
    it("enqueues a new event exactly once, ignoring it on the next poll", () => {
        const afterFirstPoll = reconcileViewerAlertQueue(
            EMPTY_VIEWER_ALERT_QUEUE_STATE,
            [follow("1")],
            DEFAULT_VIEWER_ALERTS_SETTINGS
        );
        expect(afterFirstPoll.pending).toHaveLength(1);

        // Same poll result comes back again (backend resends its whole
        // bounded window every time, not a diff) - must not double-enqueue.
        const afterSecondPoll = reconcileViewerAlertQueue(
            afterFirstPoll,
            [follow("1")],
            DEFAULT_VIEWER_ALERTS_SETTINGS
        );
        expect(afterSecondPoll.pending).toHaveLength(1);
        expect(afterSecondPoll).toBe(afterFirstPoll); // stable reference - no-op poll
    });

    it("does not enqueue a disabled event type, but still marks it seen", () => {
        const settings = { ...DEFAULT_VIEWER_ALERTS_SETTINGS, types: { ...DEFAULT_VIEWER_ALERTS_SETTINGS.types, follow: false } };
        const state = reconcileViewerAlertQueue(EMPTY_VIEWER_ALERT_QUEUE_STATE, [follow("1")], settings);
        expect(state.pending).toHaveLength(0);
        expect(state.seenIds).toContain("1");
    });

    it("enqueues nothing at all while alerts are globally disabled", () => {
        const settings = { ...DEFAULT_VIEWER_ALERTS_SETTINGS, enabled: false };
        const state = reconcileViewerAlertQueue(EMPTY_VIEWER_ALERT_QUEUE_STATE, [follow("1"), follow("2")], settings);
        expect(state.pending).toHaveLength(0);
    });

    it("bounds the pending queue so a burst can't grow it unboundedly", () => {
        const burst = Array.from({ length: 20 }, (_, i) => follow(`burst-${i}`));
        const state = reconcileViewerAlertQueue(EMPTY_VIEWER_ALERT_QUEUE_STATE, burst, DEFAULT_VIEWER_ALERTS_SETTINGS);
        expect(state.pending.length).toBeLessThanOrEqual(5);
        // Keeps the most recent ones, not the stalest - a burst should
        // still end with the queue caught up to "now", not stuck at minute 0.
        expect(state.pending[state.pending.length - 1].id).toBe("burst-19");
    });

    it("only enqueues events that are actually new across repeated polls with partial overlap", () => {
        const first = reconcileViewerAlertQueue(EMPTY_VIEWER_ALERT_QUEUE_STATE, [follow("1"), follow("2")], DEFAULT_VIEWER_ALERTS_SETTINGS);
        const second = reconcileViewerAlertQueue(first, [follow("2"), follow("3")], DEFAULT_VIEWER_ALERTS_SETTINGS);
        expect(second.pending.map((e) => e.id)).toEqual(["1", "2", "3"]);
    });
});

describe("dequeueViewerAlert", () => {
    it("pops alerts one at a time, oldest first, so they never overlap on screen", () => {
        const state = reconcileViewerAlertQueue(EMPTY_VIEWER_ALERT_QUEUE_STATE, [follow("1"), follow("2")], DEFAULT_VIEWER_ALERTS_SETTINGS);

        const first = dequeueViewerAlert(state);
        expect(first.next?.id).toBe("1");
        expect(first.state.pending).toHaveLength(1);

        const second = dequeueViewerAlert(first.state);
        expect(second.next?.id).toBe("2");
        expect(second.state.pending).toHaveLength(0);

        const third = dequeueViewerAlert(second.state);
        expect(third.next).toBeNull();
    });
});
