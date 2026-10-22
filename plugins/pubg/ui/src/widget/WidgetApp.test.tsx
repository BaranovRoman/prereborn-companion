// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { WidgetApp } from "../../widget/main";
import type { WidgetState } from "./Widget";

const state = (patch: Partial<WidgetState> = {}): WidgetState => ({
  enabled: true, count: 5, scale: 100, backgroundOpacity: 70, showHeaders: true, matches: [], revision: 1,
  configured: true, sessionStartedAt: "2026-10-22T10:00:00Z", apiStatus: "ok", ...patch,
});
const serve = (states: (WidgetState | number)[]) => {
  const fetch = vi.fn(async () => {
    const next = states.length > 1 ? states.shift()! : states[0];
    return typeof next === "number" ? new Response("{}", { status: next }) : new Response(JSON.stringify(next));
  });
  vi.stubGlobal("fetch", fetch);
};
// The first read happens on mount, the next ones every `interval`.
const settle = () => act(async () => { await vi.advanceTimersByTimeAsync(0); });
const tick = () => act(async () => { await vi.advanceTimersByTimeAsync(1000); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("PUBG OBS widget page", () => {
  it("replaces the table when a restarted worker reuses a revision number", async () => {
    vi.useFakeTimers();
    serve([
      state({ revision: 2, matches: [{ id: "a", map: "Erangel", place: 3, kills: 4, damage: 412 }] }),
      state({ revision: 2, matches: [{ id: "b", map: "Miramar", place: 1, kills: 9, damage: 990 }] }),
    ]);
    render(<WidgetApp interval={1000} obs />);
    await settle();
    expect(screen.getByText("Erangel")).toBeTruthy();
    await tick();
    expect(screen.getByText("Miramar")).toBeTruthy();
    expect(screen.queryByText("Erangel")).toBeNull();
  });
  it("explains an empty widget in a browser and stays blank in OBS", async () => {
    vi.useFakeTimers();
    serve([state({ enabled: false })]);
    const { container, unmount } = render(<WidgetApp interval={1000} obs />);
    await settle();
    expect(container.innerHTML).toBe("");
    unmount();
    render(<WidgetApp interval={1000} obs={false} />);
    await settle();
    expect(screen.getByRole("status").textContent).toContain("Виджет выключен");
  });
  it("says there is no finished match yet, and keeps the last table while the plugin restarts", async () => {
    vi.useFakeTimers();
    serve([state(), state({ matches: [{ id: "a", map: "Erangel", place: 3, kills: 4, damage: 412 }] }), 503]);
    render(<WidgetApp interval={1000} obs={false} />);
    await settle();
    expect(screen.getByRole("status").textContent).toContain("ещё нет завершённых матчей");
    await tick();
    expect(screen.getByText("Erangel")).toBeTruthy();
    await tick();
    expect(screen.getByText("Erangel")).toBeTruthy();
    expect(screen.queryByRole("status")).toBeNull();
  });
});
