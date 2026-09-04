// @vitest-environment jsdom
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OverlayApp } from "./OverlayApp";
import type { OverlayStateSnapshot } from "./types";

// jsdom has no EventSource implementation - OverlayApp opens one
// unconditionally on mount (live SSE subscription), so every test needs a
// harmless stand-in the same way AnchoredBox.test.tsx stubs ResizeObserver.
class StubEventSource {
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  constructor(public url: string) {}
  close() {}
}

// The gameplay-scene test below renders AnchoredBox (real default layout),
// which uses ResizeObserver to measure itself - jsdom doesn't implement it,
// same stub as AnchoredBox.test.tsx.
class StubResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).ResizeObserver ??= StubResizeObserver;

function baseSnapshot(overrides: Partial<OverlayStateSnapshot> = {}): OverlayStateSnapshot {
  return {
    scene: "betweenMatches",
    updatedAt: "2026-01-01T00:00:00Z",
    session: {
      hasSession: false,
      startedAt: null,
      ratingStart: null,
      ratingCurrent: null,
      ratingAdjustment: 0,
      sessionDelta: null,
      wins: 0,
      losses: 0,
      currentMatch: null,
      recentMatches: [],
    },
    layoutVersion: 0,
    account: null,
    twitchChat: null,
    overlayVisible: true,
    opendotaFavoriteHeroes: null,
    opendotaRadar: null,
    ...overrides,
  };
}

function stubFetch(snapshot: OverlayStateSnapshot) {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/overlay/state")) return Promise.resolve({ json: () => Promise.resolve(snapshot) } as Response);
      if (url.includes("/overlay/layout")) return Promise.resolve({ json: () => Promise.resolve(null) } as Response);
      if (url.includes("/overlay/queue-settings")) return Promise.resolve({ json: () => Promise.resolve(null) } as Response);
      if (url.includes("/overlay/renderer-ready")) return Promise.resolve({ json: () => Promise.resolve({ status: "ok" }) } as Response);
      return Promise.reject(new Error(`unexpected fetch in test: ${url}`));
    })
  );
}

beforeEach(() => {
  vi.stubGlobal("EventSource", StubEventSource);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.pushState({}, "", "/");
});

// WK-124 - the ONE final visibility gate, pinned at the actual page
// component (OverlayApp), not just at the Rust snapshot level: a real OBS
// Browser Source (no ?editor= query string) must render literally nothing
// when overlayVisible is false, while the "Оформление" editor preview
// (?editor=1) must keep rendering regardless.
describe("OverlayApp - WK-124 global overlay visibility gate", () => {
  it("renders nothing at all for the real broadcast output when overlay is hidden - not a styled empty state", async () => {
    stubFetch(baseSnapshot({ overlayVisible: false }));
    const { container } = render(<OverlayApp />);
    await waitFor(() => expect(container.firstChild).toBeNull());
  });

  it("renders the current scene normally when the overlay is visible", async () => {
    stubFetch(baseSnapshot({ overlayVisible: true, scene: "betweenMatches" }));
    const { container } = render(<OverlayApp />);
    await waitFor(() => expect(container.firstChild).not.toBeNull());
  });

  it("editor preview (?editor=1) keeps rendering even while the global override is OFF", async () => {
    window.history.pushState({}, "", "/?editor=1");
    stubFetch(baseSnapshot({ overlayVisible: false, scene: "gameplay" }));
    const { container } = render(<OverlayApp />);
    await waitFor(() => expect(container.firstChild).not.toBeNull());
  });
});
