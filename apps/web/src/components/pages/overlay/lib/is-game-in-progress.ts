const asRecord = (value: unknown): Record<string, unknown> | null =>
    typeof value === "object" && value !== null && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null;

export const isGameInProgress = (payload: unknown): boolean => {
    const root = asRecord(payload);
    const map = asRecord(root?.map);
    const player = asRecord(root?.player);
    const gameState = map?.game_state;

    return (
        (
            gameState === "DOTA_GAMERULES_STATE_PRE_GAME" ||
            gameState === "DOTA_GAMERULES_STATE_GAME_IN_PROGRESS"
        ) &&
        player?.activity === "playing"
    );
};
