import { describe, expect, it } from "vitest";
import { BoundedGameSoundQueue, clampVolume, MAX_QUEUED_GAME_SOUNDS } from "./game-sound-model";

const item = (eventId: string) => ({ eventId, base64: "", mime: "audio/wav", volume: 70 });

describe("BoundedGameSoundQueue", () => {
  it("starts empty", () => {
    const queue = new BoundedGameSoundQueue();
    expect(queue.size).toBe(0);
    expect(queue.takeNext()).toBeNull();
  });

  it("accepts items up to the bound", () => {
    const queue = new BoundedGameSoundQueue();
    expect(queue.enqueue(item("a"))).toBe(true);
    expect(queue.enqueue(item("b"))).toBe(true);
    expect(queue.size).toBe(MAX_QUEUED_GAME_SOUNDS);
  });

  it("drops an item once the bound is exceeded instead of growing unbounded", () => {
    const queue = new BoundedGameSoundQueue(2);
    queue.enqueue(item("a"));
    queue.enqueue(item("b"));
    // Third event in the same burst is dropped, not queued.
    expect(queue.enqueue(item("c"))).toBe(false);
    expect(queue.size).toBe(2);
  });

  it("takeNext returns items in FIFO order", () => {
    const queue = new BoundedGameSoundQueue();
    queue.enqueue(item("a"));
    queue.enqueue(item("b"));
    expect(queue.takeNext()?.eventId).toBe("a");
    expect(queue.takeNext()?.eventId).toBe("b");
    expect(queue.takeNext()).toBeNull();
  });

  it("clear empties the queue", () => {
    const queue = new BoundedGameSoundQueue();
    queue.enqueue(item("a"));
    queue.clear();
    expect(queue.size).toBe(0);
  });

  it("frees up room again once items are taken", () => {
    const queue = new BoundedGameSoundQueue(1);
    queue.enqueue(item("a"));
    expect(queue.enqueue(item("b"))).toBe(false);
    queue.takeNext();
    expect(queue.enqueue(item("c"))).toBe(true);
  });
});

describe("clampVolume", () => {
  it("clamps to 0-100", () => {
    expect(clampVolume(50)).toBe(50);
    expect(clampVolume(-5)).toBe(0);
    expect(clampVolume(150)).toBe(100);
  });

  it("falls back to 70 for a missing/corrupted value", () => {
    expect(clampVolume(undefined)).toBe(70);
    expect(clampVolume(Number.NaN)).toBe(70);
    expect(clampVolume("70")).toBe(70);
  });
});
