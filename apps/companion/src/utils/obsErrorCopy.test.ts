import { describe, expect, it } from "vitest";
import { describeObsError } from "./obsErrorCopy";

describe("describeObsError", () => {
  it("returns null when there is no error", () => {
    expect(describeObsError(null)).toBeNull();
  });

  it("maps an unreachable OBS connection, preserving the raw text as detail", () => {
    const raw = "Не удалось подключиться к OBS: IO error: Connection refused (os error 61)";
    const result = describeObsError(raw);
    expect(result).toMatchObject({
      title: "Не удалось подключиться к OBS",
      detail: raw,
    });
    expect(result?.message).toMatch(/WebSocket/);
  });

  it("maps a rejected password/version distinctly from a generic connection problem", () => {
    const raw = "OBS отклонил пароль или версию WebSocket";
    const result = describeObsError(raw);
    expect(result?.title).toBe("OBS отклонил подключение");
    expect(result?.message).toMatch(/пароль/);
    expect(result?.detail).toBe(raw);
  });

  it("falls back to a generic OBS connection message for shapes that can't be reliably classified (e.g. a closed socket, which covers both auth and unrelated closes)", () => {
    const raw = "OBS закрыл соединение";
    const result = describeObsError(raw);
    expect(result?.title).toBe("Проблема с подключением к OBS");
    expect(result?.detail).toBe(raw);
  });

  it("never leaks OS-specific raw text into the title for any known shape", () => {
    const raw = "Не удалось подключиться к OBS: IO error: Connection refused (os error 61)";
    const result = describeObsError(raw);
    expect(result?.title).not.toMatch(/os error/);
  });
});
