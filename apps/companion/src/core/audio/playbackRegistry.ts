import { invoke } from "@tauri-apps/api/core";

export interface PluginAudioScope { instance: string; generation: number; epoch: number; session: string | null }
export interface PluginAudioToken { id: string; scope: PluginAudioScope }
export type PluginAudioStatus = "queued" | "playing" | "completed" | "cancelled" | "unknown";
export interface PluginAudioFence { instance: string; generation: number; requestId: string; playbackIds: string[] }

// Only plugin sound/reminder players register here. The Twitch queue and speechSynthesis
// are deliberately absent: cancel() never touches either of them.
class PluginAudioFenceRegistry {
  private revoked = new Map<string, number>();
  private pending = new Map<string, { token: PluginAudioToken; cancel: () => boolean }>();
  accepts(token?: PluginAudioToken): boolean {
    return !token || token.scope.generation > (this.revoked.get(token.scope.instance) ?? 0);
  }
  track(token: PluginAudioToken | undefined, cancel: () => boolean): boolean {
    if (!token) return true; // Compatibility with legacy test notifications only.
    if (!this.accepts(token) || this.pending.size >= 64 || this.pending.has(token.id)) return false;
    this.pending.set(token.id, { token, cancel });
    this.report(token, "queued");
    return true;
  }
  setCancellation(token: PluginAudioToken | undefined, cancel: () => boolean) {
    if (!token) return;
    const entry = this.pending.get(token.id);
    if (entry) entry.cancel = cancel;
  }
  report(token: PluginAudioToken | undefined, status: PluginAudioStatus) {
    if (!token) return;
    if (["completed", "cancelled"].includes(status)) this.pending.delete(token.id);
    void invoke("plugin_audio_ack", { token, status }).catch(() => {});
  }
  unload() {
    // An unloading WebView cannot prove completion or cancellation. Core keeps
    // these admissions Unknown; this never touches the Twitch playback queue.
    for (const { token } of this.pending.values()) this.report(token, "unknown");
  }
  fence(request: PluginAudioFence): boolean {
    this.revoked.set(request.instance, Math.max(request.generation, this.revoked.get(request.instance) ?? 0));
    let stopped = Array.isArray(request.playbackIds) && request.playbackIds.length <= 64
      && request.playbackIds.every(id => {
        const entry = this.pending.get(id);
        return entry?.token.scope.instance === request.instance && entry.token.scope.generation <= request.generation;
      });
    for (const { token, cancel } of [...this.pending.values()]) {
      if (token.scope.instance !== request.instance || token.scope.generation > request.generation) continue;
      let ok = false;
      try { ok = cancel(); } catch { /* Unknown is never a stop proof. */ }
      this.report(token, ok ? "cancelled" : "unknown");
      stopped &&= ok;
    }
    return stopped;
  }
}
export const pluginAudioFence = new PluginAudioFenceRegistry();
if (typeof window !== "undefined") window.addEventListener("beforeunload", () => pluginAudioFence.unload());
export { PluginAudioFenceRegistry };

export function stopPluginAudio(audio: HTMLAudioElement): boolean {
  try {
    audio.onended = null;
    audio.onerror = null;
    audio.pause();
    audio.removeAttribute("src");
    audio.load(); // abort pending play/decode as well as an already playing clip
    return audio.paused && !audio.getAttribute("src");
  } catch { return false; }
}
