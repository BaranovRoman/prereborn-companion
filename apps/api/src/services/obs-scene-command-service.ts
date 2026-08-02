export type ObsSceneCommandName = "betweenMatches" | "draft" | "gameplay";

export interface ObsSceneCommand {
    id: string;
    scene: ObsSceneCommandName;
    createdAt: string;
}

// Temporary single-process command mailbox. Commands contain no OBS
// credentials: the website only sends a logical phase, while Companion keeps
// the local host/port/password and resolves the real OBS scene name.
const pendingCommands = new Map<string, ObsSceneCommand>();

export const enqueueObsSceneCommand = (
    streamUserId: string,
    scene: ObsSceneCommandName
): ObsSceneCommand => {
    const command = {
        id: crypto.randomUUID(),
        scene,
        createdAt: new Date().toISOString(),
    };
    pendingCommands.set(streamUserId, command);
    return command;
};

export const takeObsSceneCommand = (
    streamUserId: string
): ObsSceneCommand | null => {
    const command = pendingCommands.get(streamUserId) ?? null;
    if (command) pendingCommands.delete(streamUserId);
    return command;
};
