import { describe, expect, it } from "vitest";
import {
    enqueueObsSceneCommand,
    takeObsSceneCommand,
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
