// @vitest-environment jsdom
import { cleanup, renderHook } from "@testing-library/react";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useLocalOverlayPreviewReady } from "./useLocalOverlayPreviewReady";

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

  it("gives up after the bounded attempt ceiling with an actionable error, and retry() re-arms polling", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("connection refused"));
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useLocalOverlayPreviewReady());
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Drain every backoff delay (bounded, capped at 5s each) until the
    // hook gives up - never an unbounded/arbitrary wait.
    await act(async () => {
      for (let i = 0; i < 15; i += 1) {
        await vi.advanceTimersByTimeAsync(5_000);
      }
    });

    expect(result.current.ready).toBe(false);
    expect(result.current.error).toBeTruthy();
    const attemptsBeforeGivingUp = fetchMock.mock.calls.length;
    expect(attemptsBeforeGivingUp).toBeGreaterThan(1);

    // A later successful attempt after giving up must not resurrect
    // readiness on its own - only an explicit retry() re-arms polling.
    fetchMock.mockResolvedValue({ ok: true });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(fetchMock.mock.calls.length).toBe(attemptsBeforeGivingUp);

    act(() => result.current.retry());
    await flush();
    expect(result.current.ready).toBe(true);
    expect(result.current.error).toBeNull();
  });
});
