import { invoke } from "@tauri-apps/api/core";

export interface GameAudioScope { instance: string; generation: number; epoch: number; session: string | null }
export interface GameAudioToken { id: string; scope: GameAudioScope }
export type GameAudioStatus = "queued" | "playing" | "completed" | "cancelled" | "unknown";
export interface GameAudioFence { instance: string; generation: number; requestId: string }

// Only game sound/reminder players register here. The Twitch queue and speechSynthesis
// are deliberately absent: cancel() never touches either of them.
class GameAudioFenceRegistry {
  private revoked = new Map<string, number>();
  private pending = new Map<string, { token: GameAudioToken; cancel: () => boolean }>();
  accepts(token?: GameAudioToken): boolean {
    return !token || token.scope.generation > (this.revoked.get(token.scope.instance) ?? 0);
  }
  track(token: GameAudioToken | undefined, cancel: () => boolean): boolean {
    if (!token) return true; // Compatibility with legacy test notifications only.
    if (!this.accepts(token) || this.pending.size >= 64 || this.pending.has(token.id)) return false;
    this.pending.set(token.id, { token, cancel });
    this.report(token, "queued");
    return true;
  }
  setCancellation(token: GameAudioToken | undefined, cancel: () => boolean) {
    if (!token) return;
    const entry = this.pending.get(token.id);
    if (entry) entry.cancel = cancel;
  }
  report(token: GameAudioToken | undefined, status: GameAudioStatus) {
    if (!token) return;
    if (["completed", "cancelled"].includes(status)) this.pending.delete(token.id);
    void invoke("game_audio_ack", { token, status }).catch(() => {});
  }
  fence(request: GameAudioFence): boolean {
    this.revoked.set(request.instance, Math.max(request.generation, this.revoked.get(request.instance) ?? 0));
    let stopped = true;
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
export const gameAudioFence = new GameAudioFenceRegistry();
export { GameAudioFenceRegistry };

export function stopGameAudio(audio: HTMLAudioElement): boolean {
  try {
    audio.onended = null;
    audio.onerror = null;
    audio.pause();
    audio.removeAttribute("src");
    audio.load(); // abort pending play/decode as well as an already playing clip
    return audio.paused && !audio.getAttribute("src");
  } catch { return false; }
}
