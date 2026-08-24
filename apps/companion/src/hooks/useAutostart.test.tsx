// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-autostart", () => ({
  isEnabled: vi.fn(),
  enable: vi.fn(),
  disable: vi.fn(),
}));

// eslint-disable-next-line import/order
import { disable, enable, isEnabled } from "@tauri-apps/plugin-autostart";
// eslint-disable-next-line import/order
import { useAutostart } from "./useAutostart";

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useAutostart", () => {
  it("reads the real OS state on mount, not a cached/default guess", async () => {
    vi.mocked(isEnabled).mockResolvedValue(true);

    const { result } = renderHook(() => useAutostart());
    expect(result.current.state.phase).toBe("loading");

    await waitFor(() => expect(result.current.state.phase).toBe("ready"));
    expect(result.current.state).toEqual({ phase: "ready", enabled: true });
  });

  it("enabling calls the plugin's enable() and refreshes to the new real state", async () => {
    vi.mocked(isEnabled).mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    vi.mocked(enable).mockResolvedValue(undefined);

    const { result } = renderHook(() => useAutostart());
    await waitFor(() => expect(result.current.state).toEqual({ phase: "ready", enabled: false }));

    await act(async () => {
      await result.current.setAutostart(true);
    });

    expect(enable).toHaveBeenCalledTimes(1);
    expect(disable).not.toHaveBeenCalled();
    expect(result.current.state).toEqual({ phase: "ready", enabled: true });
  });

  it("disabling calls the plugin's disable()", async () => {
    vi.mocked(isEnabled).mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    vi.mocked(disable).mockResolvedValue(undefined);

    const { result } = renderHook(() => useAutostart());
    await waitFor(() => expect(result.current.state).toEqual({ phase: "ready", enabled: true }));

    await act(async () => {
      await result.current.setAutostart(false);
    });

    expect(disable).toHaveBeenCalledTimes(1);
    expect(result.current.state).toEqual({ phase: "ready", enabled: false });
  });

  it("surfaces a failed enable() as an error without losing the last-known state", async () => {
    vi.mocked(isEnabled).mockResolvedValue(false);
    vi.mocked(enable).mockRejectedValue(new Error("Access denied"));

    const { result } = renderHook(() => useAutostart());
    await waitFor(() => expect(result.current.state).toEqual({ phase: "ready", enabled: false }));

    await act(async () => {
      await result.current.setAutostart(true);
    });

    expect(result.current.state.phase).toBe("error");
    expect(result.current.state).toMatchObject({ phase: "error", enabled: false, message: expect.stringContaining("Access denied") });
  });

  it("a failed initial read surfaces as an error state, not a silent false default", async () => {
    vi.mocked(isEnabled).mockRejectedValue(new Error("plugin unavailable"));

    const { result } = renderHook(() => useAutostart());

    await waitFor(() => expect(result.current.state.phase).toBe("error"));
    expect(result.current.state).toMatchObject({ phase: "error", message: expect.stringContaining("plugin unavailable") });
  });
});
