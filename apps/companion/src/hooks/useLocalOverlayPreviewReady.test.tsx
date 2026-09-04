// @vitest-environment jsdom
import { cleanup, renderHook } from "@testing-library/react";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../services/dotaCompanionApi", () => ({
  getRuntimeHealth: vi.fn(),
}));

// eslint-disable-next-line import/order
import { getRuntimeHealth } from "../services/dotaCompanionApi";
// eslint-disable-next-line import/order
import { useLocalOverlayPreviewReady } from "./useLocalOverlayPreviewReady";
// eslint-disable-next-line import/order
import type { RuntimeHealth } from "../types/status";

const mockedGetRuntimeHealth = vi.mocked(getRuntimeHealth);

function runtimeHealthWithOverlayReason(reason: string | null): RuntimeHealth {
  const healthy = { status: "healthy" as const, reason: null, lastSuccessAt: null, lastErrorAt: null };
  return {
    schemaVersion: 1,
    generatedAt: "2026-01-01T00:00:00Z",
    app: { version: "0.5.82", platform: "windows" },
    localRuntime: {
      status: "unavailable",
      gsi: healthy,
      localSession: healthy,
      sqlite: healthy,
      sqliteSchemaVersion: null,
      overlayServer: { status: "unavailable", reason, lastSuccessAt: null, lastErrorAt: null },
    },
    integrations: { status: "healthy", obs: healthy, obsSceneAutomation: healthy, twitch: healthy, tts: healthy, gameSounds: healthy },
    cloud: { status: "healthy", backend: healthy, sync: healthy, account: healthy },
  };
}

// WK-152 - regression coverage for the actual discovered root cause of
// "Оформление preview sometimes doesn't load": the preview used to mount
// unconditionally against the local overlay server before it had finished
// its own bind-retry loop. This hook is the fix - a bounded readiness poll
// against the server's real /overlay/health endpoint, gating the iframe
// mount in DesignPage. Fake timers drive the backoff deterministically
// instead of waiting on real delays; `flush` (not testing-library's
// `waitFor`, whose own internal polling is also faked here) lets pending
// fetch promise callbacks settle after each timer advance.
const flush = async () => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
};

describe("useLocalOverlayPreviewReady", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockedGetRuntimeHealth.mockReset();
    mockedGetRuntimeHealth.mockResolvedValue(runtimeHealthWithOverlayReason(null));
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("becomes ready immediately when the overlay server already answers", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
    const { result } = renderHook(() => useLocalOverlayPreviewReady());
    await flush();
    expect(result.current.ready).toBe(true);
    expect(result.current.error).toBeNull();
  });

  it("recovers once the server finishes binding - a transient connection-refused is retried, not treated as fatal", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("connection refused"))
      .mockResolvedValueOnce({ ok: true });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useLocalOverlayPreviewReady());
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.current.ready).toBe(false);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });

    expect(result.current.ready).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  // WK-153 P0 - production regression: the old copy ("проверьте что
  // Companion запущен") was nonsensical from inside a running Companion,
  // and the poll used to stop for good after the attempt ceiling even
  // though the Rust bind-retry loop underneath never gives up. Pins both
  // fixes: the surfaced message must carry the REAL reason from
  // get_runtime_health (never the old hardcoded copy), and a later
  // successful health check must self-heal `ready` WITHOUT requiring an
  // explicit retry() call.
  it("surfaces the real backend-reported reason after the attempt threshold, then self-heals once the server binds", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("connection refused"));
    vi.stubGlobal("fetch", fetchMock);
    mockedGetRuntimeHealth.mockResolvedValue(
      runtimeHealthWithOverlayReason("Could not bind 127.0.0.1:3666: Address already in use (os error 48)"),
    );

    const { result } = renderHook(() => useLocalOverlayPreviewReady());
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Drain every backoff delay (bounded, capped at 5s each) past the
    // attempt threshold where the hook used to give up for good.
    await act(async () => {
      for (let i = 0; i < 15; i += 1) {
        await vi.advanceTimersByTimeAsync(5_000);
      }
    });

    expect(result.current.ready).toBe(false);
    expect(result.current.error).toBeTruthy();
    expect(result.current.error).not.toContain("проверьте что Companion запущен");
    expect(result.current.error).not.toContain("Проверьте, что Companion запущен");
    expect(result.current.error).toContain("Address already in use");
    const attemptsBeforeSurfacing = fetchMock.mock.calls.length;
    expect(attemptsBeforeSurfacing).toBeGreaterThan(1);

    // The server actually binds later on its own - the hook must notice
    // and recover WITHOUT the user clicking "Повторить", since the Rust
    // side's own retry loop never stopped either.
    fetchMock.mockResolvedValue({ ok: true });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(result.current.ready).toBe(true);
    expect(result.current.error).toBeNull();
    expect(fetchMock.mock.calls.length).toBeGreaterThan(attemptsBeforeSurfacing);
  });

  it("retry() forces an immediate re-probe instead of waiting for the next backoff tick", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("connection refused"));
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useLocalOverlayPreviewReady());
    await flush();
    expect(result.current.ready).toBe(false);

    fetchMock.mockResolvedValue({ ok: true });
    act(() => result.current.retry());
    await flush();
    expect(result.current.ready).toBe(true);
    expect(result.current.error).toBeNull();
  });
});
