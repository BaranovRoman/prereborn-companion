// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../services/dotaCompanionApi", () => ({
  getStreamSession: vi.fn(),
  resetStreamSession: vi.fn(),
}));

// eslint-disable-next-line import/order
import { getStreamSession, resetStreamSession } from "../services/dotaCompanionApi";
// eslint-disable-next-line import/order
import { useStreamSessionPrompt } from "./useStreamSessionPrompt";

const hoursAgo = (hours: number) => new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

const OLD_SESSION = {
  state: "active" as const,
  id: "1",
  startedAt: hoursAgo(6),
  updatedAt: hoursAgo(6),
  endedAt: null,
  wins: 4,
  losses: 3,
  sessionRatingDelta: 25,
};

const ENDED_SESSION = {
  state: "ended" as const,
  id: "1",
  startedAt: hoursAgo(6),
  updatedAt: hoursAgo(1),
  endedAt: hoursAgo(1),
  wins: 4,
  losses: 3,
  sessionRatingDelta: 25,
};

const NEW_SESSION = {
  state: "active" as const,
  id: "2",
  startedAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  endedAt: null,
  wins: 0,
  losses: 0,
  sessionRatingDelta: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
});

afterEach(() => {
  localStorage.clear();
});

describe("useStreamSessionPrompt", () => {
  it("does not show a prompt and does not crash when the backend is unavailable on startup", async () => {
    vi.mocked(getStreamSession).mockRejectedValue(new Error("network down"));

    const { result } = renderHook(() => useStreamSessionPrompt());

    await waitFor(() => expect(getStreamSession).toHaveBeenCalled());
    expect(result.current.showPrompt).toBe(false);
    expect(result.current.promptData).toBeNull();
  });

  it("shows a prompt for an old session and hides it after Начать новый стрим", async () => {
    vi.mocked(getStreamSession).mockResolvedValue(OLD_SESSION);
    vi.mocked(resetStreamSession).mockResolvedValue(NEW_SESSION);

    const { result } = renderHook(() => useStreamSessionPrompt());
    await waitFor(() => expect(result.current.showPrompt).toBe(true));

    await act(async () => {
      await result.current.onStartNew();
    });

    expect(resetStreamSession).toHaveBeenCalledTimes(1);
    expect(result.current.showPrompt).toBe(false);
    expect(result.current.promptData).toEqual(NEW_SESSION);
  });

  it("hides the prompt on Продолжить without calling any network command", async () => {
    vi.mocked(getStreamSession).mockResolvedValue(OLD_SESSION);

    const { result } = renderHook(() => useStreamSessionPrompt());
    await waitFor(() => expect(result.current.showPrompt).toBe(true));

    act(() => {
      result.current.onContinue();
    });

    expect(result.current.showPrompt).toBe(false);
    expect(resetStreamSession).not.toHaveBeenCalled();
  });

  it("does not fire a duplicate reset request on a second click while the first is in flight", async () => {
    vi.mocked(getStreamSession).mockResolvedValue(OLD_SESSION);
    let resolveReset!: (value: typeof NEW_SESSION) => void;
    vi.mocked(resetStreamSession).mockImplementation(
      () => new Promise((resolve) => { resolveReset = resolve; })
    );

    const { result } = renderHook(() => useStreamSessionPrompt());
    await waitFor(() => expect(result.current.showPrompt).toBe(true));

    let firstCall!: Promise<void>;
    let secondCall!: Promise<void>;
    act(() => {
      firstCall = result.current.onStartNew();
      secondCall = result.current.onStartNew();
    });

    expect(resetStreamSession).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveReset(NEW_SESSION);
      await firstCall;
      await secondCall;
    });
  });

  it("shows endedNewOnly (not continueOrNew) for an explicitly ended session, even though it isn't stale", async () => {
    vi.mocked(getStreamSession).mockResolvedValue(ENDED_SESSION);

    const { result } = renderHook(() => useStreamSessionPrompt());
    await waitFor(() => expect(result.current.showPrompt).toBe(true));

    expect(result.current.promptMode).toBe("endedNewOnly");
  });

  it("onContinue is a no-op once the session has been explicitly ended", async () => {
    vi.mocked(getStreamSession).mockResolvedValue(ENDED_SESSION);

    const { result } = renderHook(() => useStreamSessionPrompt());
    await waitFor(() => expect(result.current.showPrompt).toBe(true));

    act(() => {
      result.current.onContinue();
    });

    // Still showing - onContinue must not be able to dismiss an ended-state
    // prompt as if it were a stale-but-continuable one (see SessionPromptBanner,
    // which doesn't even render a "Продолжить" button in this mode).
    expect(result.current.showPrompt).toBe(true);
    expect(result.current.promptMode).toBe("endedNewOnly");
  });
});
