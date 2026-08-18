import { describe, expect, it, vi } from "vitest";
import {
    enqueueObsSceneCommand,
    takeObsSceneCommand,
    getObsSceneOverride,
} from "../services/obs-scene-command-service.js";

describe("OBS scene command mailbox", () => {
    it("delivers a command once", () => {
        enqueueObsSceneCommand("user-once", "draft");
        expect(takeObsSceneCommand("user-once")?.scene).toBe("draft");
        expect(takeObsSceneCommand("user-once")).toBeNull();
    });

    it("keeps only the latest test command", () => {
        enqueueObsSceneCommand("user-latest", "betweenMatches");
        enqueueObsSceneCommand("user-latest", "gameplay");
        expect(takeObsSceneCommand("user-latest")?.scene).toBe("gameplay");
    });
});

describe("OBS scene override (drives the live overlay's own activeScene)", () => {
    it("returns null when nothing was ever tested", () => {
        expect(getObsSceneOverride("user-no-override")).toBeNull();
    });

    it("carries the draftProtection.mode snapshot alongside the scene", () => {
        enqueueObsSceneCommand("user-draft-mode", "draft", "substitute");
        expect(getObsSceneOverride("user-draft-mode")).toEqual({
            scene: "draft",
            draftProtectionMode: "substitute",
        });
    });

    it("never carries a draftProtectionMode for non-draft test scenes", () => {
        enqueueObsSceneCommand("user-gameplay-mode", "gameplay", "off");
        expect(getObsSceneOverride("user-gameplay-mode")).toEqual({
            scene: "gameplay",
            draftProtectionMode: null,
        });
    });

    it("reflects a re-test with the newly saved mode, not the previous one", () => {
        enqueueObsSceneCommand("user-retest", "draft", "cover");
        expect(getObsSceneOverride("user-retest")?.draftProtectionMode).toBe("cover");

        enqueueObsSceneCommand("user-retest", "draft", "off");
        expect(getObsSceneOverride("user-retest")?.draftProtectionMode).toBe("off");
    });

    it("expires after the TTL, same as the underlying test command", () => {
        vi.useFakeTimers();
        try {
            enqueueObsSceneCommand("user-expiring", "draft", "substitute");
            expect(getObsSceneOverride("user-expiring")).not.toBeNull();

            vi.advanceTimersByTime(60_001);
            expect(getObsSceneOverride("user-expiring")).toBeNull();
        } finally {
            vi.useRealTimers();
        }
    });
});
