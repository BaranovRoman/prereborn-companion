// @vitest-environment jsdom
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useTwitchChatSession } from "./useTwitchChatSession";

// WK-78 regression test: the poll loop/TTS used to live inside
// TwitchChatPage.tsx, so leaving the Chat tab (unmounting that component)
// stopped delivery/TTS entirely. It's now owned by whoever calls
// useTwitchChatSession() (HomePage in the real app, `Harness` here) - a
// consumer mounting/unmounting underneath must not start/stop polling, and
// must never end up with two pollers running at once.

vi.mock("../services/dotaCompanionApi", () => ({
  getTwitchChat: vi.fn(),
  getSileroTtsStatus: vi.fn().mockResolvedValue({ enabled: false, state: "notStarted", lastError: null, resourcesReady: true, voice: "xenia" }),
  setSileroTtsEnabled: vi.fn().mockResolvedValue({ enabled: false, state: "notStarted", lastError: null, resourcesReady: true, voice: "xenia" }),
  synthesizeSileroTts: vi.fn(),
  diagnosticsTraceTtsFrontend: vi.fn().mockResolvedValue(undefined),
  getSkipHotkeyStatus: vi.fn().mockResolvedValue({ enabled: true, shortcut: "CommandOrControl+Alt+F10", registered: true, lastError: null }),
  setSkipHotkey: vi.fn(),
}));

// WK-83 - captured so tests can simulate the OS-level hotkey firing by
// invoking whatever callback useTwitchChatSession.ts registered, instead of
// needing a real global shortcut.
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));

// eslint-disable-next-line import/order
import { listen } from "@tauri-apps/api/event";
// eslint-disable-next-line import/order
import {
  getSileroTtsStatus, getSkipHotkeyStatus, getTwitchChat, setSkipHotkey, synthesizeSileroTts,
} from "../services/dotaCompanionApi";
// eslint-disable-next-line import/order
import type { TwitchChatSession } from "./useTwitchChatSession";

// Resolves/rejects on demand, so a test can control exactly when a
// synthesize*Tts call "comes back" relative to a skipTts() call in between -
// this is what makes the late-arriving-result race actually testable.
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

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
const chatMessage = (id: string, text: string): typeof CHAT_MESSAGE => ({ ...CHAT_MESSAGE, id, text });

describe("useTwitchChatSession", () => {
  beforeEach(() => {
    vi.mocked(getTwitchChat).mockReset().mockResolvedValue(STATUS);
    vi.mocked(listen).mockClear().mockResolvedValue(() => {});
    vi.mocked(getSkipHotkeyStatus).mockClear()
      .mockResolvedValue({ enabled: true, shortcut: "CommandOrControl+Alt+F10", registered: true, lastError: null });
    vi.mocked(setSkipHotkey).mockReset();
    vi.mocked(synthesizeSileroTts).mockReset();
    // jsdom doesn't implement HTMLMediaElement.play() - stub it so
    // `new Audio(url).play()` resolves and stays "playing" (no `ended`
    // event ever fires in jsdom) instead of throwing, which is what the
    // skipTts() tests below need to observe an audio element that's
    // actually mid-playback rather than one whose play() already rejected
    // straight into cleanup(). `.mockClear()` first: vi.spyOn on an
    // already-spied method returns the *same* mock instance rather than a
    // fresh one, so without this its call count would keep accumulating
    // across every test in this file, not just the current one.
    vi.spyOn(window.HTMLMediaElement.prototype, "play").mockClear().mockResolvedValue(undefined);
    vi.spyOn(window.HTMLMediaElement.prototype, "pause").mockClear().mockImplementation(() => {});
  });

  // Belt-and-suspenders alongside the per-test mock clearing above: a test
  // that forgets to unmount would otherwise leave its poll-loop `setInterval`
  // running in the background, reacting to whatever the *next* test's
  // getTwitchChat()/synthesize*Tts() mocks return and inflating call counts
  // the next test asserts on.
  afterEach(() => cleanup());

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

  // WK-80: Silero is the default/primary engine, but must never strand a
  // message when it's unavailable - the frontend fallback chain (Silero ->
  // system speechSynthesis, since WK-80 removed Piper from the middle tier)
  // is what actually keeps the queue moving, independent of whether the
  // backend engine is failing.
  it("falls back from Silero to system speechSynthesis when Silero synthesis fails, and keeps draining the queue", async () => {
    vi.mocked(synthesizeSileroTts).mockReset().mockRejectedValue(new Error("Silero unavailable"));

    // jsdom has no SpeechSynthesis - same minimal fake as the "system
    // voice" skipTts test below: `new SpeechSynthesisUtterance(text)` for
    // construction, speak() dispatches it, and onend/onerror is how
    // speakWithSystem's `done` gets called.
    class FakeUtterance {
      lang = "";
      onstart?: () => void;
      onend?: () => void;
      onerror?: () => void;
      constructor(public text: string) {}
    }
    const speak = vi.fn((utterance: FakeUtterance) => { utterance.onend?.(); });
    const cancel = vi.fn();
    Object.defineProperty(window, "SpeechSynthesisUtterance", { configurable: true, value: FakeUtterance });
    Object.defineProperty(window, "speechSynthesis", { configurable: true, value: { speak, cancel } });

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
    // Silero failed - system speechSynthesis must be tried next for the
    // same message, not silently dropped.
    await waitFor(() => expect(speak).toHaveBeenCalled(), { timeout: 4000 });

    // @ts-expect-error - restoring jsdom's (nonexistent) original descriptors
    delete window.speechSynthesis;
    // @ts-expect-error - ditto
    delete window.SpeechSynthesisUtterance;
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

  // WK-83 - global "skip current TTS" hotkey (src-tauri/src/hotkeys.rs).
  describe("skipTts", () => {
    const enableSilero = async (session: TwitchChatSession) => {
      session.updateSetting("ttsEnabled", true);
      session.updateSetting("ttsEngine", "silero");
      await waitFor(() => expect(session.settings.ttsEnabled).toBe(true));
    };

    it("is a safe no-op when nothing is speaking or queued", async () => {
      let session: TwitchChatSession | undefined;
      render(<Harness showChat={true} onSession={(s) => { session = s; }} />);
      await waitFor(() => expect(session).toBeDefined());

      expect(() => session!.skipTts()).not.toThrow();
      expect(session!.lastSkipAt).toBeNull();
      expect(vi.mocked(synthesizeSileroTts)).not.toHaveBeenCalled();
    });

    it("stops audio that's already playing and immediately advances to the next queued message", async () => {
      vi.mocked(synthesizeSileroTts).mockReset()
        .mockResolvedValueOnce(btoa("wav bytes for message one"))
        .mockResolvedValueOnce(btoa("wav bytes for message two"));

      let session: TwitchChatSession | undefined;
      render(<Harness showChat={true} onSession={(s) => { session = s; }} />);
      await waitFor(() => expect(session).toBeDefined());
      await enableSilero(session!);

      // Both messages arrive in the same poll batch, so both are enqueued
      // before drainTts() ever runs - message two must stay queued (not
      // dropped) until message one is skipped.
      vi.mocked(getTwitchChat).mockResolvedValue({
        ...STATUS, messages: [chatMessage("msg-1", "первое"), chatMessage("msg-2", "второе")],
      });

      await waitFor(() => expect(vi.mocked(synthesizeSileroTts)).toHaveBeenCalledTimes(1), { timeout: 4000 });
      // Let the resolved synth promise's microtasks (Audio construction,
      // play()) settle so there's a genuinely "playing" audio element to skip.
      await waitFor(() => expect(window.HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(1));

      session!.skipTts();

      expect(window.HTMLMediaElement.prototype.pause).toHaveBeenCalledTimes(1);
      // lastSkipAt is React state - skipTts() itself is a plain (non-act-
      // wrapped) call here, so the re-render that publishes it to `session`
      // isn't guaranteed to have flushed synchronously yet.
      await waitFor(() => expect(session!.lastSkipAt).not.toBeNull());
      // Queue not cleared, TTS not disabled - message two is picked up next.
      await waitFor(() => expect(vi.mocked(synthesizeSileroTts)).toHaveBeenCalledTimes(2));
      expect(vi.mocked(synthesizeSileroTts).mock.calls[1][0]).toContain("второе");
      expect(session!.settings.ttsEnabled).toBe(true);
    });

    it("skipping mid-synthesis discards the late result instead of playing it, without killing the sidecar, then still advances once it resolves", async () => {
      const firstSynthesis = deferred<string>();
      vi.mocked(synthesizeSileroTts).mockReset()
        .mockReturnValueOnce(firstSynthesis.promise)
        .mockResolvedValueOnce(btoa("wav bytes for message two"));

      let session: TwitchChatSession | undefined;
      render(<Harness showChat={true} onSession={(s) => { session = s; }} />);
      await waitFor(() => expect(session).toBeDefined());
      await enableSilero(session!);

      vi.mocked(getTwitchChat).mockResolvedValue({
        ...STATUS, messages: [chatMessage("msg-1", "первое"), chatMessage("msg-2", "второе")],
      });
      await waitFor(() => expect(vi.mocked(synthesizeSileroTts)).toHaveBeenCalledTimes(1), { timeout: 4000 });

      // Still awaiting the sidecar - skip must not touch it (no enable/
      // disable call, no second synth request for the same message), only
      // mark this attempt stale.
      session!.skipTts();
      await waitFor(() => expect(session!.lastSkipAt).not.toBeNull());

      // The sidecar "finishes late", after the skip.
      firstSynthesis.resolve(btoa("wav bytes for message one - must never play"));
      await Promise.resolve(); // let the resolved promise's .then chain run

      expect(window.HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
      // The stale result's own done() call (via the generation check inside
      // speakWithSilero) is what advances the queue - message two follows.
      await waitFor(() => expect(vi.mocked(synthesizeSileroTts)).toHaveBeenCalledTimes(2));
      expect(vi.mocked(synthesizeSileroTts).mock.calls[1][0]).toContain("второе");

      await waitFor(() => expect(window.HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(1));
    });

    it("repeated rapid presses never double-advance the queue or throw", async () => {
      vi.mocked(synthesizeSileroTts).mockReset()
        .mockResolvedValueOnce(btoa("one"))
        .mockResolvedValueOnce(btoa("two"));

      let session: TwitchChatSession | undefined;
      render(<Harness showChat={true} onSession={(s) => { session = s; }} />);
      await waitFor(() => expect(session).toBeDefined());
      await enableSilero(session!);

      vi.mocked(getTwitchChat).mockResolvedValue({
        ...STATUS, messages: [chatMessage("msg-1", "первое"), chatMessage("msg-2", "второе")],
      });
      await waitFor(() => expect(vi.mocked(synthesizeSileroTts)).toHaveBeenCalledTimes(1), { timeout: 4000 });
      await waitFor(() => expect(window.HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(1));

      expect(() => {
        session!.skipTts(); // advances to message two (still synthesizing)
        session!.skipTts(); // message two has no cancellable audio yet - safe no-op besides another generation bump
        session!.skipTts(); // already idle again after the second call's bump - safe no-op
      }).not.toThrow();

      // Message two's (now-stale) synth still resolves exactly once and
      // still shouldn't play, but must not desync the queue/settings.
      await Promise.resolve();
      expect(session!.settings.ttsEnabled).toBe(true);
      expect(vi.mocked(synthesizeSileroTts)).toHaveBeenCalledTimes(2);
    });

    // 2026-08 audit: the exact "A playing, B and C queued, two rapid Skip
    // presses land before B ever becomes current" scenario, spelled out
    // message-by-message so the generation-epoch reasoning in the audit
    // report is backed by an assertion, not just a read of the code.
    it("A/B/C: two rapid presses before B becomes current skip A and B, never touch C, and C is the one that actually plays", async () => {
      const synthB = deferred<string>();
      vi.mocked(synthesizeSileroTts).mockReset()
        .mockResolvedValueOnce(btoa("wav for A"))
        .mockReturnValueOnce(synthB.promise)
        .mockResolvedValueOnce(btoa("wav for C"));

      let session: TwitchChatSession | undefined;
      render(<Harness showChat={true} onSession={(s) => { session = s; }} />);
      await waitFor(() => expect(session).toBeDefined());
      await enableSilero(session!);

      vi.mocked(getTwitchChat).mockResolvedValue({
        ...STATUS,
        messages: [
          chatMessage("msg-a", "это A"), chatMessage("msg-b", "это B"), chatMessage("msg-c", "это C"),
        ],
      });

      // A is actually playing.
      await waitFor(() => expect(vi.mocked(synthesizeSileroTts)).toHaveBeenCalledTimes(1), { timeout: 4000 });
      await waitFor(() => expect(window.HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(1));

      // Press 1: skips A (audio playing -> activeCancel pauses it and
      // synchronously advances the queue, dispatching B's synthesis).
      session!.skipTts();
      await waitFor(() => expect(window.HTMLMediaElement.prototype.pause).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(vi.mocked(synthesizeSileroTts)).toHaveBeenCalledTimes(2));

      // Press 2 fires while B is still awaiting its (controlled, unresolved)
      // synthesis IPC call - B has not "become current" (no audio, no
      // activeCancel) yet. Per the generation-epoch design this must only
      // bump `generation` again, with no second pause() call (nothing
      // cancellable exists for B) and no interaction with C at all yet.
      session!.skipTts();
      expect(window.HTMLMediaElement.prototype.pause).toHaveBeenCalledTimes(1); // still just A's
      expect(vi.mocked(synthesizeSileroTts)).toHaveBeenCalledTimes(2); // C not started yet

      // B "finishes late" - its result must never play, and C must be what
      // starts next once B's own generation check discards it.
      synthB.resolve(btoa("wav for B - must never play"));
      await waitFor(() => expect(vi.mocked(synthesizeSileroTts)).toHaveBeenCalledTimes(3), { timeout: 4000 });
      // "C" gets transliterated ("си") by the TTS normalization pipeline
      // (WK-82) - text content isn't the point here, only that call #3 is
      // for the C message, not a repeat of A/B.
      expect(vi.mocked(synthesizeSileroTts).mock.calls[2][0]).toContain("это си");

      // C is untouched by either press (both fired strictly before C was
      // ever dispatched) - it plays normally to completion.
      await waitFor(() => expect(window.HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(2));
      expect(window.HTMLMediaElement.prototype.pause).toHaveBeenCalledTimes(1); // B's non-existent audio was never paused, C wasn't skipped
      expect(session!.settings.ttsEnabled).toBe(true);
    });

    it("system voice: cancelling speaks no confirmation phrase and advances to the next message", async () => {
      // jsdom has no SpeechSynthesis - stub minimal fakes that mirror the
      // real contract useTwitchChatSession.ts relies on: `new
      // SpeechSynthesisUtterance(text)` for construction, speak() dispatches
      // it, cancel() fires that utterance's own onerror (this is what `done`
      // is wired to, not a separate "cancelled" callback).
      class FakeUtterance {
        lang = "";
        onstart?: () => void;
        onend?: () => void;
        onerror?: () => void;
        constructor(public text: string) {}
      }
      let lastUtterance: FakeUtterance | null = null;
      const speak = vi.fn((utterance: FakeUtterance) => { lastUtterance = utterance; });
      const cancel = vi.fn(() => lastUtterance?.onerror?.());
      Object.defineProperty(window, "SpeechSynthesisUtterance", { configurable: true, value: FakeUtterance });
      Object.defineProperty(window, "speechSynthesis", { configurable: true, value: { speak, cancel } });

      let session: TwitchChatSession | undefined;
      render(<Harness showChat={true} onSession={(s) => { session = s; }} />);
      await waitFor(() => expect(session).toBeDefined());
      session!.updateSetting("ttsEnabled", true);
      session!.updateSetting("ttsEngine", "system");
      await waitFor(() => expect(session!.settings.ttsEngine).toBe("system"));

      vi.mocked(getTwitchChat).mockResolvedValue({
        ...STATUS, messages: [chatMessage("msg-1", "первое"), chatMessage("msg-2", "второе")],
      });
      await waitFor(() => expect(speak).toHaveBeenCalledTimes(1), { timeout: 4000 });

      session!.skipTts();

      expect(cancel).toHaveBeenCalledTimes(1);
      // The whole point: no extra utterance was dispatched to announce the
      // skip - Companion's TTS is heard over Desktop Audio in OBS, so a
      // spoken (or beeped) confirmation would go out to the whole stream.
      await waitFor(() => expect(speak).toHaveBeenCalledTimes(2));
      // Both messages share an author - the name is suppressed on the
      // second regardless of the first having been skipped rather than
      // fully spoken (see chat-model.test.ts's matching regression test).
      expect(speak.mock.calls[1][0].text).toBe("второе");

      // @ts-expect-error - restoring jsdom's (nonexistent) original descriptors
      delete window.speechSynthesis;
      // @ts-expect-error - ditto
      delete window.SpeechSynthesisUtterance;
    });

    it("listens for the OS-level hotkey event and triggers the same skip path", async () => {
      vi.mocked(synthesizeSileroTts).mockReset()
        .mockResolvedValueOnce(btoa("one"))
        .mockResolvedValueOnce(btoa("two"));

      let session: TwitchChatSession | undefined;
      render(<Harness showChat={true} onSession={(s) => { session = s; }} />);
      await waitFor(() => expect(session).toBeDefined());
      await waitFor(() => expect(vi.mocked(listen)).toHaveBeenCalledWith("hotkeys://skip-tts", expect.any(Function)));
      await enableSilero(session!);

      vi.mocked(getTwitchChat).mockResolvedValue({
        ...STATUS, messages: [chatMessage("msg-1", "первое"), chatMessage("msg-2", "второе")],
      });
      await waitFor(() => expect(window.HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(1), { timeout: 4000 });

      const [, onSkipEvent] = vi.mocked(listen).mock.calls.find(([name]) => name === "hotkeys://skip-tts")!;
      onSkipEvent({} as never);

      expect(window.HTMLMediaElement.prototype.pause).toHaveBeenCalledTimes(1);
      await waitFor(() => expect(vi.mocked(synthesizeSileroTts)).toHaveBeenCalledTimes(2));
    });
  });

  describe("skip hotkey settings", () => {
    it("loads the persisted skip-hotkey status on mount", async () => {
      vi.mocked(getSkipHotkeyStatus).mockResolvedValue({
        enabled: true, shortcut: "Ctrl+Alt+F9", registered: true, lastError: null,
      });

      let session: TwitchChatSession | undefined;
      render(<Harness showChat={true} onSession={(s) => { session = s; }} />);
      await waitFor(() => expect(session?.skipHotkeyStatus?.shortcut).toBe("Ctrl+Alt+F9"));
    });

    it("updateSkipHotkey persists a new combo and adopts the returned status", async () => {
      vi.mocked(setSkipHotkey).mockResolvedValue({
        enabled: true, shortcut: "Ctrl+Alt+F8", registered: true, lastError: null,
      });

      let session: TwitchChatSession | undefined;
      render(<Harness showChat={true} onSession={(s) => { session = s; }} />);
      await waitFor(() => expect(session).toBeDefined());

      await session!.updateSkipHotkey(true, "Ctrl+Alt+F8");

      expect(vi.mocked(setSkipHotkey)).toHaveBeenCalledWith(true, "Ctrl+Alt+F8");
      await waitFor(() => expect(session!.skipHotkeyStatus?.shortcut).toBe("Ctrl+Alt+F8"));
    });

    it("a failed set-hotkey attempt never invents state - it re-fetches from the backend, which itself never abandons a working combo", async () => {
      vi.mocked(setSkipHotkey).mockRejectedValue(new Error("Не удалось зарегистрировать комбинацию"));
      // Mirrors hotkeys.rs's rollback: the backend keeps serving the
      // previously-working combo after a failed attempt.
      vi.mocked(getSkipHotkeyStatus)
        .mockResolvedValueOnce({ enabled: true, shortcut: "CommandOrControl+Alt+F10", registered: true, lastError: null })
        .mockResolvedValueOnce({
          enabled: true, shortcut: "CommandOrControl+Alt+F10", registered: true,
          lastError: "Не удалось зарегистрировать комбинацию",
        });

      let session: TwitchChatSession | undefined;
      render(<Harness showChat={true} onSession={(s) => { session = s; }} />);
      await waitFor(() => expect(session).toBeDefined());
      await waitFor(() => expect(session!.skipHotkeyStatus?.shortcut).toBe("CommandOrControl+Alt+F10"));

      await expect(session!.updateSkipHotkey(true, "Ctrl+AlreadyTaken")).rejects.toThrow();

      await waitFor(() => expect(session!.skipHotkeyStatus?.lastError).toContain("Не удалось"));
      // Still the old, working combo - never silently swapped to the
      // rejected/failed one.
      expect(session!.skipHotkeyStatus?.shortcut).toBe("CommandOrControl+Alt+F10");
    });
  });
});
