import { streamApiClient } from "@/entities/stream-user/api/stream-client";
import type { BroadcastSceneId } from "@/entities/stream-overlay-layout/model/types";

export const obsSceneControlApi = {
    testScene: async (scene: BroadcastSceneId): Promise<void> => {
        await streamApiClient.post("/account/me/obs-test-scene", { scene });
    },
};
