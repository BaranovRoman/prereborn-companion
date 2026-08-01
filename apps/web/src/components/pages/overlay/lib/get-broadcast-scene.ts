import type { BroadcastSceneId } from "@/entities/stream-overlay-layout/model/types";

const asRecord = (value: unknown): Record<string, unknown> | null =>
    typeof value === "object" && value !== null && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null;

export const getBroadcastScene = (payload: unknown): BroadcastSceneId => {
    const root = asRecord(payload);
    const map = asRecord(root?.map);
    const player = asRecord(root?.player);
    const gameState = map?.game_state;

    if (player?.activity !== "playing") return "betweenMatches";

    if (
        gameState === "DOTA_GAMERULES_STATE_HERO_SELECTION" ||
        gameState === "DOTA_GAMERULES_STATE_STRATEGY_TIME"
    ) {
        return "draft";
    }

    if (
        gameState === "DOTA_GAMERULES_STATE_PRE_GAME" ||
        gameState === "DOTA_GAMERULES_STATE_GAME_IN_PROGRESS"
    ) {
        return "gameplay";
    }

    return "betweenMatches";
};
