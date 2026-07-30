import { describe, expect, it } from "vitest";
import { isGameInProgress } from "./is-game-in-progress";

describe("isGameInProgress", () => {
    it("enables game widgets only during an active match", () => {
        expect(
            isGameInProgress({
                map: { game_state: "DOTA_GAMERULES_STATE_GAME_IN_PROGRESS" },
                player: { activity: "playing" },
            })
        ).toBe(true);
    });

    it.each([
        "DOTA_GAMERULES_STATE_HERO_SELECTION",
        "DOTA_GAMERULES_STATE_STRATEGY_TIME",
        "DOTA_GAMERULES_STATE_PRE_GAME",
        "DOTA_GAMERULES_STATE_POST_GAME",
    ])("keeps the queue scene during %s", (gameState) => {
        expect(
            isGameInProgress({
                map: { game_state: gameState },
                player: { activity: "playing" },
            })
        ).toBe(false);
    });

    it("keeps the queue scene when the player is in the menu", () => {
        expect(
            isGameInProgress({
                map: { game_state: "DOTA_GAMERULES_STATE_GAME_IN_PROGRESS" },
                player: { activity: "menu" },
            })
        ).toBe(false);
    });
});
