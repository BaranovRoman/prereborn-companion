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
  getSileroTtsStatus: vi.fn().mockResolvedValue({ enabled: false, state: "notStarted", lastError: null, resourcesReady: true, voice: "xenia" }),
  setSileroTtsEnabled: vi.fn().mockResolvedValue({ enabled: false, state: "notStarted", lastError: null, resourcesReady: true, voice: "xenia" }),
  synthesizeSileroTts: vi.fn(),
  diagnosticsTraceTtsFrontend: vi.fn().mockResolvedValue(undefined),
}));

// eslint-disable-next-line import/order
import { getTwitchChat, synthesizePiperTts, synthesizeSileroTts } from "../services/dotaCompanionApi";
// eslint-disable-next-line import/order
import type { TwitchChatSession } from "./useTwitchChatSession";

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
function Harness({ showChat, onSession }: { showChat: boolean; onSession?: (session: TwitchChatSession) => void }) {
  const session = useTwitchChatSession();
  onSession?.(session);
  return showChat ? <div data-testid="chat-mounted" /> : null;
}

const CHAT_MESSAGE = {
  id: "msg-1",
  author: "viewer",
  authorId: "123",
  authorLogin: "viewer",
  color: null,
  text: "го дальше",
  badges: [],
  messageType: "text",
  receivedAt: new Date().toISOString(),
};

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

  // WK-81: Silero is the default/primary engine, but must never strand a
  // message when it's unavailable - the frontend fallback chain (Silero ->
  // Piper -> system) is what actually keeps the queue moving, independent
  // of whichever backend engine is failing.
  it("falls back from Silero to Piper when Silero synthesis fails, and keeps draining the queue", async () => {
    vi.mocked(synthesizeSileroTts).mockReset().mockRejectedValue(new Error("Silero unavailable"));
    vi.mocked(synthesizePiperTts).mockReset().mockResolvedValue(btoa("not a real wav but bytes are enough for this test"));

    let session: TwitchChatSession | undefined;
    // Empty on the initial poll (matching STATUS) so `known` is seeded with
    // no ids yet - the message is only added below, after TTS is enabled,
    // so it arrives as a genuinely "fresh" message rather than backlog the
    // poll loop intentionally never reads aloud (see poll()'s
    // `initialized.current` gate).
    const { unmount } = render(<Harness showChat={true} onSession={(s) => { session = s; }} />);

    await waitFor(() => expect(session).toBeDefined());
    await waitFor(() => expect(vi.mocked(getTwitchChat).mock.calls.length).toBeGreaterThan(0));
    session!.updateSetting("ttsEnabled", true);
    session!.updateSetting("ttsEngine", "silero");
    vi.mocked(getTwitchChat).mockResolvedValue({ ...STATUS, messages: [CHAT_MESSAGE] });

    await waitFor(() => expect(vi.mocked(synthesizeSileroTts)).toHaveBeenCalled(), { timeout: 4000 });
    // Silero failed - Piper must be tried next for the same message, not
    // silently dropped.
    await waitFor(() => expect(vi.mocked(synthesizePiperTts)).toHaveBeenCalled(), { timeout: 4000 });

    unmount();
  }, 15000);
});
