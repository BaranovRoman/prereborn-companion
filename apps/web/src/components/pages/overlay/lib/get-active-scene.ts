import type { BroadcastSceneId, DraftProtectionMode } from "@/entities/stream-overlay-layout/model/types";
import type { SessionLifecycleState } from "@/entities/stream-session/model/types";
import { getBroadcastScene } from "./get-broadcast-scene";

// WK-53 - the public overlay's calm final scene, distinct from the
// configurable gameplay/draft/betweenMatches scenes (those have their own
// widget layout entries - see OverlayLayout.scenes - "streamEnded" doesn't,
// it's rendered by reusing the existing QueueScene/Between Matches shell,
// see queue-scene-ui.tsx's StreamEndedBanner).
export type ActiveScene = BroadcastSceneId | "streamEnded";

interface GetActiveSceneParams {
    sessionState: SessionLifecycleState;
    sceneOverride: BroadcastSceneId | null;
    companionIsOnline: boolean;
    companionPayload: unknown;
    draftProtectionMode: DraftProtectionMode;
}

// Precedence, most to least important:
// 1. sessionState === "ended" - the stream was explicitly ended. This wins
//    over EVERYTHING else, including a manual OBS test sceneOverride: a
//    stale/reconnecting GSI tick from a Companion that's still running (see
//    get-broadcast-scene.ts) must never be able to pull the public overlay
//    back into gameplay/draft once the streamer has ended the stream.
// 2. sceneOverride - manual "Тест сцен OBS" trigger.
// 3. Companion offline + draft protection enabled - snipe-protection
//    fallback (see the original comment this replaced in overlay/index.tsx).
// 4. Whatever getBroadcastScene derives from the raw GSI payload.
export const getActiveScene = ({
    sessionState,
    sceneOverride,
    companionIsOnline,
    companionPayload,
    draftProtectionMode,
}: GetActiveSceneParams): ActiveScene => {
    if (sessionState === "ended") return "streamEnded";
    if (sceneOverride) return sceneOverride;
    if (!companionIsOnline && draftProtectionMode !== "off") return "draft";
    return getBroadcastScene(companionPayload);
};
