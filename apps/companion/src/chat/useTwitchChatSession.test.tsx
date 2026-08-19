// @vitest-environment jsdom
import { render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useTwitchChatSession } from "./useTwitchChatSession";

// WK-78 regression test: the poll loop/TTS used to live inside
// TwitchChatPage.tsx, so leaving the Chat tab (unmounting that component)
// stopped delivery/TTS entirely. It's now owned by whoever calls
// useTwitchChatSession() (HomePage in the real app, `Harness` here) - a
// consumer mounting/unmounting underneath must not start/stop polling, and
// must never end up with two pollers running at once.

vi.mock("../services/dotaCompanionApi", () => ({
  getTwitchChat: vi.fn(),
  getPiperTtsStatus: vi.fn().mockResolvedValue({ enabled: false, state: "notStarted", lastError: null, resourcesReady: false }),
  setPiperTtsEnabled: vi.fn().mockResolvedValue({ enabled: false, state: "notStarted", lastError: null, resourcesReady: false }),
  synthesizePiperTts: vi.fn(),
  diagnosticsTraceTtsFrontend: vi.fn().mockResolvedValue(undefined),
}));

// eslint-disable-next-line import/order
import { getTwitchChat } from "../services/dotaCompanionApi";

const STATUS = {
  accountConnected: true,
  configured: true,
  displayName: "streamer",
  connected: true,
  state: "connected" as const,
  messages: [],
};

// Stands in for HomePage: owns the session unconditionally, and renders a
// "Chat tab" consumer only when `showChat` is true - mirroring HomePage's
// `view === "chat" ? <TwitchChatPage session={chatSession} /> : ...`.
function Harness({ showChat }: { showChat: boolean }) {
  useTwitchChatSession();
  return showChat ? <div data-testid="chat-mounted" /> : null;
}

describe("useTwitchChatSession", () => {
  beforeEach(() => {
    vi.mocked(getTwitchChat).mockReset().mockResolvedValue(STATUS);
  });

  it("keeps polling after the Chat consumer unmounts, and does not start a second poller on remount", async () => {
    const { rerender, unmount } = render(<Harness showChat={true} />);

    await waitFor(() => expect(vi.mocked(getTwitchChat).mock.calls.length).toBeGreaterThan(0));
    const callsWhileOnChat = vi.mocked(getTwitchChat).mock.calls.length;

    // Leave Chat: only the consumer unmounts, Harness (the session owner)
    // does not.
    rerender(<Harness showChat={false} />);
    await waitFor(
      () => expect(vi.mocked(getTwitchChat).mock.calls.length).toBeGreaterThan(callsWhileOnChat),
      { timeout: 4000 },
    );

    // Return to Chat.
    rerender(<Harness showChat={true} />);
    const beforeReturn = vi.mocked(getTwitchChat).mock.calls.length;
    await waitFor(
      () => expect(vi.mocked(getTwitchChat).mock.calls.length).toBeGreaterThan(beforeReturn),
      { timeout: 4000 },
    );

    // Two more poll intervals (~3s at the hook's 1500ms cadence): a second,
    // independently-running poller would double this count.
    const before = vi.mocked(getTwitchChat).mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 3300));
    const after = vi.mocked(getTwitchChat).mock.calls.length;
    expect(after - before).toBeGreaterThanOrEqual(1);
    expect(after - before).toBeLessThanOrEqual(3);

    unmount();
  }, 15000);
});
