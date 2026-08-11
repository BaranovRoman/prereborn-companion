import type { BroadcastSceneId, DraftProtectionMode } from "@/entities/stream-overlay-layout/model/types";

export const resolveOverlayScene = ({
    override,
    companionOnline,
    derived,
    draftProtectionMode,
}: {
    override: BroadcastSceneId | null;
    companionOnline: boolean;
    derived: BroadcastSceneId;
    draftProtectionMode: DraftProtectionMode;
}): BroadcastSceneId => {
    if (override) return override;
    if (!companionOnline) {
        return draftProtectionMode === "off" ? "betweenMatches" : "draft";
    }
    return derived;
};
