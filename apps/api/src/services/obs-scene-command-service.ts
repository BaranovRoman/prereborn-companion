import type { DraftProtectionMode } from "./stream-overlay-layout-service.js";

export type ObsSceneCommandName = "betweenMatches" | "draft" | "gameplay";

export interface ObsSceneCommand {
    id: string;
    scene: ObsSceneCommandName;
    createdAt: string;
}

export interface ObsSceneOverride {
    scene: ObsSceneCommandName;
    // Snapshot of the saved draftProtection.mode at the moment the test
    // command was issued - null for non-draft test scenes. Carried
    // explicitly on the override itself (rather than relying on the overlay
    // poll separately re-reading the current layout) so a manual draft-scene
    // test is fully self-contained and doesn't depend on layout fetch timing
    // matching up with the override (see WK-77 follow-up: "расширь
    // существующий override, а не создавай второй").
    draftProtectionMode: DraftProtectionMode | null;
}

// Temporary single-process command mailbox. Commands contain no OBS
// credentials: the website only sends a logical phase, while Companion keeps
// the local host/port/password and resolves the real OBS scene name.
const pendingCommands = new Map<string, ObsSceneCommand>();
const sceneOverrides = new Map<string, ObsSceneOverride & { expiresAt: number }>();
const SCENE_OVERRIDE_TTL_MS = 60_000;

export const enqueueObsSceneCommand = (
    streamUserId: string,
    scene: ObsSceneCommandName,
    draftProtectionMode: DraftProtectionMode | null = null
): ObsSceneCommand => {
    const command = {
        id: crypto.randomUUID(),
        scene,
        createdAt: new Date().toISOString(),
    };
    pendingCommands.set(streamUserId, command);
    sceneOverrides.set(streamUserId, {
        scene,
        draftProtectionMode: scene === "draft" ? draftProtectionMode : null,
        expiresAt: Date.now() + SCENE_OVERRIDE_TTL_MS,
    });
    return command;
};

export const getObsSceneOverride = (
    streamUserId: string
): ObsSceneOverride | null => {
    const override = sceneOverrides.get(streamUserId);
    if (!override) return null;
    if (override.expiresAt <= Date.now()) {
        sceneOverrides.delete(streamUserId);
        return null;
    }
    return { scene: override.scene, draftProtectionMode: override.draftProtectionMode };
};

export const takeObsSceneCommand = (
    streamUserId: string
): ObsSceneCommand | null => {
    const command = pendingCommands.get(streamUserId) ?? null;
    if (command) pendingCommands.delete(streamUserId);
    return command;
};
