// Compatibility names for the Dota UI while it moves into its signed package.
export { pluginAudioFence as gameAudioFence, PluginAudioFenceRegistry as GameAudioFenceRegistry, stopPluginAudio as stopGameAudio } from "../core/audio/playbackRegistry";
export type { PluginAudioScope as GameAudioScope, PluginAudioToken as GameAudioToken, PluginAudioStatus as GameAudioStatus, PluginAudioFence as GameAudioFence } from "../core/audio/playbackRegistry";
