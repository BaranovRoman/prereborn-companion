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
import { getSileroTtsStatus, getTwitchChat, synthesizePiperTts, synthesizeSileroTts } from "../services/dotaCompanionApi";
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

  // Regression for the reported "Прослушать" bug: clicking preview appeared
  // to do nothing and the settings-page status line stayed stuck on
  // "waiting for first message" forever, even after a successful preview -
  // previewSileroVoice never called refreshSileroStatus() on either branch,
  // unlike speakWithSilero (the real chat-message path) which does on both.
  describe("previewSileroVoice", () => {
    it("refreshes sileroStatus after a successful preview, so the status line moves off its default", async () => {
      // jsdom doesn't implement HTMLMediaElement.play() - stub it so the
      // success branch's `new Audio(url).play()` resolves instead of
      // throwing, same as a real browser. This is the first test in this
      // file to exercise Silero's success path (the existing fallback test
      // only ever rejects synthesizeSileroTts, so it never reaches here).
      vi.spyOn(window.HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
      vi.mocked(synthesizeSileroTts).mockReset().mockResolvedValue(btoa("not a real wav but bytes are enough"));
      // Only previewSileroVoice's refreshSileroStatus() calls this in this
      // test (settings never enable TTS/switch engines, so no chat-message
      // synthesis or its own status refresh happens) - one resolved value is
      // enough to prove the post-preview refresh happened and landed.
      vi.mocked(getSileroTtsStatus).mockReset()
        .mockResolvedValue({ enabled: true, state: "ready", lastError: null, resourcesReady: true, voice: "aidar" });

      let session: TwitchChatSession | undefined;
      render(<Harness showChat={true} onSession={(s) => { session = s; }} />);
      await waitFor(() => expect(session).toBeDefined());
      // Let the mount-time enable-effect's own getSileroTtsStatus-unrelated
      // setup settle first, so the call-count delta below is attributable
      // only to the preview itself.
      await waitFor(() => expect(session!.sileroStatus).not.toBeNull());
      const callsBeforePreview = vi.mocked(getSileroTtsStatus).mock.calls.length;

      session!.previewSileroVoice("aidar");
      await waitFor(() => expect(session!.previewBusy).toBe(false));

      // The regression: previewSileroVoice must call refreshSileroStatus()
      // (i.e. getSileroTtsStatus()) on success, same as speakWithSilero
      // already does - this is what moves the settings-page status line off
      // its permanent "waiting for first message" default.
      expect(vi.mocked(getSileroTtsStatus).mock.calls.length).toBeGreaterThan(callsBeforePreview);
      await waitFor(() => expect(session!.sileroStatus?.state).toBe("ready"));
      expect(session!.previewError).toBeNull();
    });

    it("surfaces a visible error and still refreshes sileroStatus when preview synthesis fails", async () => {
      vi.mocked(synthesizeSileroTts).mockReset().mockRejectedValue(new Error("Silero недоступен"));
      vi.mocked(getSileroTtsStatus).mockReset().mockResolvedValue({
        enabled: true, state: "crashed", lastError: "boom", resourcesReady: true, voice: "aidar",
      });

      let session: TwitchChatSession | undefined;
      render(<Harness showChat={true} onSession={(s) => { session = s; }} />);
      await waitFor(() => expect(session).toBeDefined());

      session!.previewSileroVoice("aidar");
      await waitFor(() => expect(session!.previewBusy).toBe(false));

      expect(session!.previewError).toContain("Silero недоступен");
      await waitFor(() => expect(session!.sileroStatus?.state).toBe("crashed"));
    });
  });
});
