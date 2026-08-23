import { describe, expect, it } from "vitest";
import { describeBackendStatus } from "./backendStatus";

describe("describeBackendStatus", () => {
  it("asks for a token when none is configured, even before any status arrives", () => {
    expect(describeBackendStatus(null)).toMatchObject({ tone: "warning", ready: false });
    expect(
      describeBackendStatus({
        companion_token_configured: false,
        backend_state: "waiting",
        backend_last_error: null,
      })
    ).toMatchObject({ label: "Не настроено", tone: "warning", ready: false });
  });

  it("never claims disconnected for a token that is configured but not yet checked", () => {
    const result = describeBackendStatus({
      companion_token_configured: true,
      backend_state: "waiting",
      backend_last_error: null,
    });
    expect(result.tone).not.toBe("error");
    expect(result.label.toLowerCase()).not.toContain("disconnected");
    expect(result.ready).toBe(false);
  });

  it("reports connected and ready only once the backend has actually confirmed reachability", () => {
    const result = describeBackendStatus({
      companion_token_configured: true,
      backend_state: "connected",
      backend_last_error: null,
    });
    expect(result).toMatchObject({ tone: "ok", ready: true });
  });

  it("treats a transient failure under active retry as recovering, not a hard error", () => {
    const result = describeBackendStatus({
      companion_token_configured: true,
      backend_state: "recovering",
      backend_last_error: "Сеть недоступна: connection refused",
    });
    expect(result.tone).toBe("warning");
    expect(result.ready).toBe(false);
    expect(result.detail).toContain("connection refused");
  });

  it("only reports a hard error once the backend is confirmed unavailable", () => {
    const result = describeBackendStatus({
      companion_token_configured: true,
      backend_state: "unavailable",
      backend_last_error: "Backend ответил 503",
    });
    expect(result.tone).toBe("error");
    expect(result.ready).toBe(false);
    expect(result.detail).toContain("503");
  });
});
