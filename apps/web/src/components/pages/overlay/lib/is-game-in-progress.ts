import { getBroadcastScene } from "./get-broadcast-scene";

export const isGameInProgress = (payload: unknown): boolean =>
    getBroadcastScene(payload) === "gameplay";
