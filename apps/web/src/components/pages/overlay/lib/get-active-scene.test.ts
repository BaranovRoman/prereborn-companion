import { describe, expect, it } from "vitest";
import { getActiveScene } from "./get-active-scene";

const gameplayPayload = {
    map: { game_state: "DOTA_GAMERULES_STATE_GAME_IN_PROGRESS" },
    player: { activity: "playing" },
};

const baseParams = {
    sessionState: "active" as const,
    sceneOverride: null,
    companionIsOnline: true,
    companionPayload: gameplayPayload,
    draftProtectionMode: "off" as const,
};

describe("getActiveScene", () => {
    it("derives from GSI when the session is active and nothing else overrides", () => {
        expect(getActiveScene(baseParams)).toBe("gameplay");
    });

    it("respects a manual sceneOverride while the session is active", () => {
        expect(getActiveScene({ ...baseParams, sceneOverride: "draft" })).toBe("draft");
    });

    it("falls back to draft when companion is offline and draft protection is enabled", () => {
        expect(
            getActiveScene({
                ...baseParams,
                companionIsOnline: false,
                draftProtectionMode: "cover",
            })
        ).toBe("draft");
    });

    // WK-53 - the core regression this function exists to prevent: an ended
    // session must show the final scene no matter what a stale/reconnecting
    // GSI tick, a leftover manual sceneOverride, or the draft-protection
    // fallback would otherwise resolve to.
    it("forces streamEnded when the session has ended, ignoring a live gameplay GSI payload", () => {
        expect(getActiveScene({ ...baseParams, sessionState: "ended" })).toBe("streamEnded");
    });

    it("forces streamEnded even when a manual sceneOverride is still set", () => {
        expect(
            getActiveScene({ ...baseParams, sessionState: "ended", sceneOverride: "gameplay" })
        ).toBe("streamEnded");
    });

    it("forces streamEnded even when companion is offline with draft protection enabled", () => {
        expect(
            getActiveScene({
                ...baseParams,
                sessionState: "ended",
                companionIsOnline: false,
                draftProtectionMode: "cover",
            })
        ).toBe("streamEnded");
    });

    it("behaves like an active session when state is none (brand-new account, first poll)", () => {
        expect(getActiveScene({ ...baseParams, sessionState: "none" })).toBe("gameplay");
    });
});
