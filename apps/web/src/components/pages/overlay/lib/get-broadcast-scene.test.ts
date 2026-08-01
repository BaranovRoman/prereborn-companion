import { describe, expect, it } from "vitest";
import { getBroadcastScene } from "./get-broadcast-scene";

const payload = (game_state: string, activity = "playing") => ({
    map: { game_state },
    player: { activity },
});

describe("getBroadcastScene", () => {
    it.each([
        "DOTA_GAMERULES_STATE_HERO_SELECTION",
        "DOTA_GAMERULES_STATE_STRATEGY_TIME",
    ])("uses draft for %s", (state) => {
        expect(getBroadcastScene(payload(state))).toBe("draft");
    });

    it.each([
        "DOTA_GAMERULES_STATE_PRE_GAME",
        "DOTA_GAMERULES_STATE_GAME_IN_PROGRESS",
    ])("uses gameplay for %s", (state) => {
        expect(getBroadcastScene(payload(state))).toBe("gameplay");
    });

    it("uses between matches after the game", () => {
        expect(getBroadcastScene(payload("DOTA_GAMERULES_STATE_POST_GAME"))).toBe(
            "betweenMatches"
        );
    });

    it("uses between matches outside playing activity", () => {
        expect(
            getBroadcastScene(
                payload("DOTA_GAMERULES_STATE_GAME_IN_PROGRESS", "menu")
            )
        ).toBe("betweenMatches");
    });
});
