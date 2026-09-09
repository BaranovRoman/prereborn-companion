import { describe, expect, it } from "vitest";
import { describeGsiError } from "./gsiErrorCopy";

describe("describeGsiError", () => {
  it("returns null when there is no error", () => {
    expect(describeGsiError(null)).toBeNull();
  });

  it("maps a bind failure to a human title/message, preserving the raw OS text as detail", () => {
    const raw = "Could not bind 127.0.0.1:3665: Address already in use (os error 48)";
    const result = describeGsiError(raw);
    expect(result).toMatchObject({
      title: "Порт для приёма данных Dota 2 занят",
      detail: raw,
    });
    expect(result?.message.length).toBeGreaterThan(0);
  });

  it("maps the listener-stopped shape to a transient reconnecting message", () => {
    const raw = "GSI listener stopped; reconnecting";
    const result = describeGsiError(raw);
    expect(result).toMatchObject({
      title: "Локальный GSI-сервис перезапускается",
      detail: raw,
    });
  });

  it("falls back to a safe generic message for an unrecognized shape, never surfacing the raw string as the title", () => {
    const raw = "some unexpected future error text";
    const result = describeGsiError(raw);
    expect(result?.title).not.toBe(raw);
    expect(result?.detail).toBe(raw);
  });
});
