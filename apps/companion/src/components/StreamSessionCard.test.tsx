// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StreamSessionCard } from "./StreamSessionCard";

afterEach(cleanup);

const ACTIVE_SESSION = {
  state: "active" as const,
  id: "1",
  startedAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  endedAt: null,
  wins: 2,
  losses: 1,
  sessionRatingDelta: 25,
};

const ENDED_SESSION = { ...ACTIVE_SESSION, state: "ended" as const, endedAt: new Date().toISOString() };

const baseProps = {
  promptMode: "hidden" as const,
  showPrompt: false,
  busy: false,
  error: null,
  onContinue: vi.fn(),
  onStartNew: vi.fn().mockResolvedValue(undefined),
  onEndStream: vi.fn().mockResolvedValue(undefined),
  refresh: vi.fn().mockResolvedValue(undefined),
};

// Companion UI 2.0 follow-up - "Stream controls must not depend on OBS/GSI"
// (задача п.5): this component is deliberately given no OBS/GSI props at
// all - its rendering can only ever depend on `sessionPrompt`, which is
// sourced purely from the backend/companion-token session fetch. That
// absence of an OBS/GSI dependency in the component's own prop surface is
// itself part of what these tests pin down.
describe("StreamSessionCard", () => {
  it("shows a loading state before the initial fetch settles", () => {
    render(<StreamSessionCard sessionPrompt={{ ...baseProps, promptData: null }} />);
    expect(screen.getByText("Проверяем состояние…")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("shows an honest unavailable state (not a fake-enabled Start/End button) when the initial fetch failed", () => {
    render(
      <StreamSessionCard
        sessionPrompt={{ ...baseProps, promptData: null, error: "Сначала добавьте companion token." }}
      />
    );
    expect(screen.getByText("Недоступно")).toBeTruthy();
    expect(screen.getByText("Сначала добавьте companion token.")).toBeTruthy();
    // No Start/End action - only the honest retry button (see the
    // dedicated "offers a retry button" test below).
    expect(screen.queryByRole("button", { name: /Завершить|Начать/ })).toBeNull();
  });

  it("offers End Stream when a session is active - no active-session prop mentions OBS or GSI", () => {
    render(<StreamSessionCard sessionPrompt={{ ...baseProps, promptData: ACTIVE_SESSION }} />);
    expect(screen.getByText("Стрим идёт")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Завершить стрим" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Начать новый/ })).toBeNull();
  });

  it("offers Start New when the session is ended", () => {
    render(<StreamSessionCard sessionPrompt={{ ...baseProps, promptData: ENDED_SESSION }} />);
    expect(screen.getByText("Стрим завершён")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Начать новый стрим" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Завершить/ })).toBeNull();
  });

  it("End Stream requires confirmation before calling onEndStream", () => {
    const onEndStream = vi.fn().mockResolvedValue(undefined);
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<StreamSessionCard sessionPrompt={{ ...baseProps, promptData: ACTIVE_SESSION, onEndStream }} />);

    fireEvent.click(screen.getByRole("button", { name: "Завершить стрим" }));

    expect(confirmSpy).toHaveBeenCalled();
    expect(onEndStream).toHaveBeenCalledTimes(1);
    confirmSpy.mockRestore();
  });

  it("does not call onEndStream if the confirmation is declined", () => {
    const onEndStream = vi.fn().mockResolvedValue(undefined);
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<StreamSessionCard sessionPrompt={{ ...baseProps, promptData: ACTIVE_SESSION, onEndStream }} />);

    fireEvent.click(screen.getByRole("button", { name: "Завершить стрим" }));

    expect(onEndStream).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it("Start New does not require confirmation", () => {
    const onStartNew = vi.fn().mockResolvedValue(undefined);
    render(<StreamSessionCard sessionPrompt={{ ...baseProps, promptData: ENDED_SESSION, onStartNew }} />);

    fireEvent.click(screen.getByRole("button", { name: "Начать новый стрим" }));

    expect(onStartNew).toHaveBeenCalledTimes(1);
  });

  it("disables the action button and shows a busy label while a request is in flight", () => {
    render(<StreamSessionCard sessionPrompt={{ ...baseProps, promptData: ACTIVE_SESSION, busy: true }} />);
    const button = screen.getByRole("button", { name: "Завершаем…" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });

  it("keeps the last known state (active) and shows the error when a request fails", () => {
    render(
      <StreamSessionCard sessionPrompt={{ ...baseProps, promptData: ACTIVE_SESSION, error: "Backend ответил 500" }} />
    );
    expect(screen.getByText("Стрим идёт")).toBeTruthy();
    expect(screen.getByText("Ошибка: Backend ответил 500")).toBeTruthy();
  });

  it("suppresses its own error display when the stale-session banner (continueOrNew) is actually showing it", () => {
    render(
      <StreamSessionCard
        sessionPrompt={{
          ...baseProps,
          promptData: ACTIVE_SESSION,
          error: "Backend ответил 500",
          showPrompt: true,
          promptMode: "continueOrNew",
        }}
      />
    );
    expect(screen.queryByText(/Ошибка:/)).toBeNull();
  });

  // Regression: getSessionPromptMode returns "endedNewOnly" for EVERY ended
  // session unconditionally (see session-prompt.ts), so `showPrompt` alone
  // is true whenever state is "ended" - even though AppShell deliberately
  // never renders the banner for "endedNewOnly" (this card is its sole
  // replacement there, see AppShell.tsx). A naive `!showPrompt` check would
  // silently swallow a failed "Начать новый стрим" click's error because
  // showPrompt looks "true" without the banner ever actually being drawn.
  it("still shows its own error for an ended session, even though showPrompt is true (the banner for that mode is suppressed elsewhere)", () => {
    render(
      <StreamSessionCard
        sessionPrompt={{
          ...baseProps,
          promptData: ENDED_SESSION,
          error: "Backend ответил 500",
          showPrompt: true,
          promptMode: "endedNewOnly",
        }}
      />
    );
    expect(screen.getByText("Ошибка: Backend ответил 500")).toBeTruthy();
  });

  // Regression: the initial session fetch never retries itself, so once
  // `error` is set (e.g. "add a companion token first") there was no way
  // back to a working state short of restarting the whole app - even after
  // the user fixed the underlying problem in Настройки.
  it("offers a retry button in the unavailable state that calls refresh()", () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    render(
      <StreamSessionCard
        sessionPrompt={{ ...baseProps, promptData: null, error: "Сначала добавьте companion token.", refresh }}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Обновить" }));

    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
