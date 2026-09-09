import { describe, expect, it } from "vitest";
import { describeAuthError } from "./authErrorCopy";

describe("describeAuthError", () => {
  it("maps invalid credentials to a short actionable message", () => {
    const result = describeAuthError("Неверный email или пароль.");
    expect(result).toMatchObject({ title: "Не удалось войти" });
    expect(result.message).toMatch(/логин и пароль/);
  });

  it("maps an unreachable-server error to a network message, not the raw reqwest text", () => {
    const raw = "Не удалось связаться с PreReborn: error sending request for url (https://prereborn.ru/api/stream/auth/login)";
    const result = describeAuthError(raw);
    expect(result).toMatchObject({ title: "Нет связи с сервером PreReborn", detail: raw });
    expect(result.message).not.toContain("reqwest");
    expect(result.message).not.toContain("http");
  });

  it("maps a 5xx backend status to a server-unavailable message", () => {
    const result = describeAuthError("Backend ответил 500 Internal Server Error");
    expect(result.title).toBe("Сервер PreReborn временно недоступен");
  });

  it("maps a non-5xx, non-401 backend status to a generic rejected-request message, distinct from the server case", () => {
    const result = describeAuthError("Backend ответил 403 Forbidden");
    expect(result.title).toBe("Сервер PreReborn отклонил запрос");
    expect(result.title).not.toBe("Сервер PreReborn временно недоступен");
  });

  it("maps a malformed response body to its own message", () => {
    const raw = "Неверный ответ входа: invalid type: null, expected a string at line 1 column 42";
    const result = describeAuthError(raw);
    expect(result.title).toBe("Сервер PreReborn вернул неожиданный ответ");
    expect(result.detail).toBe(raw);
  });

  it("falls back to a safe generic message for an unrecognized shape (e.g. HTTP client build failure), never the raw string as the title", () => {
    const raw = "HTTP client error: builder error";
    const result = describeAuthError(raw);
    expect(result.title).not.toBe(raw);
    expect(result.detail).toBe(raw);
  });

  it("never exposes the password in any mapped message, for any known shape", () => {
    const shapes = [
      "Неверный email или пароль.",
      "Не удалось связаться с PreReborn: connection refused",
      "Backend ответил 500 Internal Server Error",
      "Неверный ответ входа: unexpected token",
      "HTTP client error: builder error",
    ];
    for (const raw of shapes) {
      const result = describeAuthError(raw);
      expect(result.title).not.toMatch(/password|пароль:/i);
    }
  });
});
