// Compatibility names; one shared, game-independent playback implementation.
export { MAX_QUEUED_PLUGIN_AUDIO as MAX_QUEUED_GAME_SOUNDS, BoundedPluginAudioQueue as BoundedGameSoundQueue, base64ToObjectUrl, clampVolume } from "../core/audio/playbackModel";
export type { PluginAudioPlayback as GameSoundPlayback } from "../core/audio/playbackModel";
