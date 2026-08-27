// Bounded pending-queue policy for game-sound "play" events that arrive
// while a previous one is still playing (задача п.7: "не превращать в
// cacophony... не делай бесконечную очередь"). "Currently playing" itself is
// NOT tracked here - same split as chat/chat-model.ts's BoundedTtsQueue vs
// useTwitchChatSession.ts's `speaking` ref - the caller (useGameSoundEngine)
// owns that.
export const MAX_QUEUED_GAME_SOUNDS = 2;

export interface GameSoundPlayback {
  eventId: string;
  base64: string;
  mime: string;
  volume: number;
  correlationId: string;
  emittedAtMs: number;
}

export class BoundedGameSoundQueue {
  private readonly pending: GameSoundPlayback[] = [];
  constructor(private readonly limit = MAX_QUEUED_GAME_SOUNDS) {}

  /** Returns false when the burst overflowed the bound and this item was dropped instead of queued. */
  enqueue(item: GameSoundPlayback): boolean {
    if (this.pending.length >= this.limit) return false;
    this.pending.push(item);
    return true;
  }

  takeNext(): GameSoundPlayback | null {
    return this.pending.shift() ?? null;
  }

  get size() {
    return this.pending.length;
  }

  clear() {
    this.pending.length = 0;
  }
}

/** Decodes a base64 payload into a playable Blob object URL - shared by event playback and preview. */
export const base64ToObjectUrl = (base64: string, mime: string): string => {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  return URL.createObjectURL(new Blob([bytes], { type: mime }));
};

export const clampVolume = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) return 70;
  return Math.min(100, Math.max(0, value));
};
