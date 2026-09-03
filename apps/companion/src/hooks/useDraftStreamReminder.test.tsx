// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDraftStreamReminder } from "./useDraftStreamReminder";

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));
vi.mock("../services/dotaCompanionApi", () => ({
  synthesizeSileroTts: vi.fn(),
}));

import { listen } from "@tauri-apps/api/event";
import { synthesizeSileroTts } from "../services/dotaCompanionApi";

const STORAGE_KEY = "companion-system-voice-reminders-v1";
const DRAFT_STREAM_NOT_STARTED_EVENT = "reminders://draft-stream-not-started";

function fireDraftReminderEvent() {
  const call = vi.mocked(listen).mock.calls.find(([name]) => name === DRAFT_STREAM_NOT_STARTED_EVENT);
  if (!call) throw new Error("useDraftStreamReminder never registered a listener for the reminder event");
  const [, handler] = call;
  return (handler as (event: unknown) => void)({});
}

// WK-136 - "Стрим не запущен". Deliberately independent of the Twitch chat
// TTS queue - these tests pin dedup/reconnect/state-transition behavior on
// the frontend half (the Rust half, draft_reminder.rs, has its own
// should_fire/handle_gsi test coverage for the actual dedup decision).
describe("useDraftStreamReminder", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.mocked(listen).mockClear().mockResolvedValue(() => {});
    vi.mocked(synthesizeSileroTts).mockReset().mockResolvedValue(btoa("not a real wav but bytes are enough"));
    vi.spyOn(window.HTMLMediaElement.prototype, "play").mockClear().mockResolvedValue(undefined);
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:mock-url");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  });

  afterEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it("defaults to enabled with nothing persisted", () => {
    const { result } = renderHook(() => useDraftStreamReminder("xenia"));
    expect(result.current.enabled).toBe(true);
  });

  it("persists a disabled choice and reloads it", () => {
    const { result, unmount } = renderHook(() => useDraftStreamReminder("xenia"));
    act(() => result.current.setEnabled(false));
    expect(result.current.enabled).toBe(false);
    expect(localStorage.getItem(STORAGE_KEY)).toBe("false");
    unmount();

    const { result: reloaded } = renderHook(() => useDraftStreamReminder("xenia"));
    expect(reloaded.current.enabled).toBe(false);
  });

  it("registers a listener for the reminder event on mount", async () => {
    renderHook(() => useDraftStreamReminder("xenia"));
    await waitFor(() => expect(vi.mocked(listen)).toHaveBeenCalledWith(DRAFT_STREAM_NOT_STARTED_EVENT, expect.any(Function)));
  });

  it("plays the reminder via Silero using the given voice when enabled", async () => {
    renderHook(() => useDraftStreamReminder("baya"));
    await waitFor(() => expect(vi.mocked(listen)).toHaveBeenCalled());

    await act(async () => { await fireDraftReminderEvent(); });

    expect(vi.mocked(synthesizeSileroTts)).toHaveBeenCalledWith("Стрим не запущен", "baya");
  });

  it("picks up a changed voice without re-registering the listener", async () => {
    const { rerender } = renderHook(({ voice }) => useDraftStreamReminder(voice), { initialProps: { voice: "xenia" as const } });
    await waitFor(() => expect(vi.mocked(listen)).toHaveBeenCalled());
    rerender({ voice: "kseniya" as const });

    await act(async () => { await fireDraftReminderEvent(); });

    expect(vi.mocked(listen)).toHaveBeenCalledTimes(1); // no re-subscribe on voice change
    expect(vi.mocked(synthesizeSileroTts)).toHaveBeenCalledWith("Стрим не запущен", "kseniya");
  });

  it("does not synthesize/play anything while disabled", async () => {
    const { result } = renderHook(() => useDraftStreamReminder("xenia"));
    await waitFor(() => expect(vi.mocked(listen)).toHaveBeenCalled());
    act(() => result.current.setEnabled(false));

    await act(async () => { await fireDraftReminderEvent(); });

    expect(vi.mocked(synthesizeSileroTts)).not.toHaveBeenCalled();
  });

  it("a failed synthesis is swallowed, never thrown from the event handler", async () => {
    vi.mocked(synthesizeSileroTts).mockRejectedValue(new Error("Silero unavailable"));
    renderHook(() => useDraftStreamReminder("xenia"));
    await waitFor(() => expect(vi.mocked(listen)).toHaveBeenCalled());

    await expect(act(async () => { await fireDraftReminderEvent(); })).resolves.not.toThrow();
  });

  it("unsubscribes on unmount", async () => {
    const unlisten = vi.fn();
    vi.mocked(listen).mockResolvedValue(unlisten);
    const { unmount } = renderHook(() => useDraftStreamReminder("xenia"));
    await waitFor(() => expect(vi.mocked(listen)).toHaveBeenCalled());

    unmount();
    await waitFor(() => expect(unlisten).toHaveBeenCalled());
  });
});
