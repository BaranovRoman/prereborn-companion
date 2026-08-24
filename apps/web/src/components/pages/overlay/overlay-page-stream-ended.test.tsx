import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OverlayPage } from "./index";
import { buildOverlayData } from "@/components/pages/stream/stream-ended/stream-ended-scene.fixtures";

afterEach(cleanup);

// WK-98 - QueueScene pulls in heavy, unrelated machinery (next/image, WebGL
// canvas background, several polling hooks) that has nothing to do with
// scene *routing*, which is what this file tests - stubbed out so these
// tests isolate OverlayPage's getActiveScene-driven branch selection.
vi.mock("@/components/pages/stream/queue/queue-scene", () => ({
    QueueScene: () => <div data-testid="queue-scene-stub" />,
}));

// WK-98 - the actual regression this suite exists to prevent: before this
// task, activeScene === "streamEnded" rendered the SAME QueueScene branch as
// "betweenMatches" (see git history of overlay/index.tsx) - StreamEndedScene
// must now be a genuinely distinct branch, and the WK-53 "ended wins over
// everything" precedence (get-active-scene.ts) must still reach it through
// the real component tree, not just in getActiveScene's own unit tests.
describe("OverlayPage scene routing", () => {
    it("renders StreamEndedScene, not QueueScene, when sessionState is ended", () => {
        render(
            <OverlayPage
                publicToken="11111111-1111-1111-1111-111111111111"
                initialData={buildOverlayData({ sessionState: "ended" })}
            />
        );

        expect(screen.getByTestId("stream-ended-scene")).toBeTruthy();
        expect(screen.queryByTestId("queue-scene-stub")).toBeNull();
    });

    it("still renders QueueScene for the active betweenMatches scene", () => {
        render(
            <OverlayPage
                publicToken="11111111-1111-1111-1111-111111111111"
                initialData={buildOverlayData({
                    sessionState: "active",
                    sessionSummary: null,
                    companion: { isOnline: true, receivedAt: null, companionVersion: null, payload: {} },
                })}
            />
        );

        expect(screen.getByTestId("queue-scene-stub")).toBeTruthy();
        expect(screen.queryByTestId("stream-ended-scene")).toBeNull();
    });

    it("ended still wins over a leftover manual sceneOverride, through the real component tree", () => {
        render(
            <OverlayPage
                publicToken="11111111-1111-1111-1111-111111111111"
                initialData={buildOverlayData({
                    sessionState: "ended",
                    sceneOverride: "gameplay",
                })}
            />
        );

        expect(screen.getByTestId("stream-ended-scene")).toBeTruthy();
        expect(screen.queryByTestId("queue-scene-stub")).toBeNull();
    });
});
