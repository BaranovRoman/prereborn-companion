// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Companion UI 2.0 - AppShell is the single owner of every app-root hook
// (status/GSI/diagnostics/updater/chat/session-prompt/autostart) and the
// sidebar navigation that swaps between the 4 real page components
// (HomePage/SettingsPage/DiagnosticsPage render for real here - only
// TwitchChatPage is stubbed, since its own session-shape contract is
// already covered by chat/useTwitchChatSession.test.tsx and doesn't need
// re-testing here). These tests pin: all 4 sections are reachable from the
// sidebar, exactly one section's content is visible at a time, the
// post-split cleanup actually happened (OBS mapping / companion token no
// longer duplicated into Диагностика, hotkeys live in Настройки), and -
// Companion UI 2.0 follow-up - stream session controls never depend on
// OBS/GSI status (задача п.5).

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));

// A realistic, fully-populated status so ObsScenePanel (which renders
// nothing at all when status/config is null - see ObsScenePanel.tsx) has
// something real to show. `let` (not `const`) so individual tests can swap
// in an OBS/GSI-down variant to prove session controls are unaffected.
let statusFixture: Record<string, unknown> = buildStatusFixture();

function buildStatusFixture(overrides: Record<string, unknown> = {}) {
  return {
    dota_found: true,
    dota_path: "C:/Steam/steamapps/common/dota 2 beta",
    dota_source: "auto",
    gsi_installed: true,
    gsi_config_path: "C:/.../gamestate_integration_prereborn.cfg",
    server_running: true,
    gsi_state: "connected",
    gsi_last_error: null,
    server_port: 3600,
    request_count: 12,
    last_event: null,
    log_dir: "C:/Users/test/AppData/Roaming/PreReborn Companion/logs",
    legacy_cleanup_in_progress: false,
    backend_url: "https://prereborn.ru/api",
    companion_token_configured: true,
    obs_config: {
      enabled: true,
      host: "localhost",
      port: 4455,
      password: "",
      between_matches_scene: "Between Matches",
      draft_scene: "Draft",
      gameplay_scene: "Gameplay",
      post_stream_scene: "Post Stream",
    },
    obs_connected: true,
    obs_state: "connected",
    obs_active_scene: "betweenMatches",
    obs_last_error: null,
    companion_version: "0.5.26",
    ...overrides,
  };
}

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

let sessionPromptFixture: Record<string, unknown> = buildSessionPromptFixture();

function buildSessionPromptFixture(overrides: Record<string, unknown> = {}) {
  return {
    promptData: null,
    promptMode: "hidden",
    showPrompt: false,
    busy: false,
    error: null,
    onContinue: vi.fn(),
    onStartNew: vi.fn().mockResolvedValue(undefined),
    onEndStream: vi.fn().mockResolvedValue(undefined),
    refresh: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

vi.mock("../hooks/useStatus", () => ({
  useStatus: () => ({ status: statusFixture, setStatus: vi.fn(), refresh: vi.fn().mockResolvedValue(undefined) }),
}));
vi.mock("../hooks/useGsiEvents", () => ({ useGsiEvents: () => [] }));
vi.mock("../hooks/useDiagnostics", () => ({
  useDiagnostics: () => ({ status: null, refresh: vi.fn().mockResolvedValue(undefined), setStatus: vi.fn() }),
}));
vi.mock("../hooks/useUpdater", () => ({
  useUpdater: () => ({
    state: { phase: "idle" },
    checkForUpdate: vi.fn().mockResolvedValue(undefined),
    installUpdate: vi.fn(),
    restartToApply: vi.fn(),
    dismiss: vi.fn(),
  }),
}));
vi.mock("../hooks/useAutostart", () => ({
  useAutostart: () => ({
    state: { phase: "ready", enabled: false },
    busy: false,
    setAutostart: vi.fn(),
    refresh: vi.fn(),
  }),
}));
vi.mock("../hooks/useStreamSessionPrompt", () => ({
  useStreamSessionPrompt: () => sessionPromptFixture,
}));
vi.mock("../chat/useTwitchChatSession", () => ({
  useTwitchChatSession: () => ({
    skipHotkeyStatus: { enabled: false, shortcut: "CommandOrControl+Alt+F10", registered: false, lastError: null },
    skipHotkeyBusy: false,
    updateSkipHotkey: vi.fn().mockResolvedValue(undefined),
  }),
}));
vi.mock("./TwitchChatPage", () => ({
  TwitchChatPage: () => <div data-testid="chat-page-stub">Chat stub</div>,
}));

// eslint-disable-next-line import/order
import { AppShell } from "./AppShell";

const clickNav = (label: string) => {
  fireEvent.click(screen.getByRole("button", { name: new RegExp(label) }));
};

beforeEach(() => {
  // Skip the first-run setup wizard so Главная renders its normal content -
  // matches how a returning user (the realistic post-update case) sees it.
  // Individual tests override this where the wizard state itself matters.
  localStorage.setItem("companion-setup-complete", "true");
  statusFixture = buildStatusFixture();
  sessionPromptFixture = buildSessionPromptFixture();
});

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe("AppShell navigation", () => {
  it("shows Главная by default", () => {
    render(<AppShell />);
    expect(screen.getByText("Состояние эфира")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Главная/ }).className).toContain("is-active");
  });

  it("switches to Чат and hides Главная content", () => {
    render(<AppShell />);
    clickNav("Чат");
    expect(screen.getByTestId("chat-page-stub")).toBeTruthy();
    expect(screen.queryByText("Состояние эфира")).toBeNull();
    expect(screen.getByRole("button", { name: /Чат/ }).className).toContain("is-active");
  });

  it("switches to Настройки and hides Главная/Чат content", () => {
    render(<AppShell />);
    clickNav("Настройки");
    expect(screen.getByRole("heading", { name: "Настройки" })).toBeTruthy();
    expect(screen.queryByText("Состояние эфира")).toBeNull();
    expect(screen.queryByTestId("chat-page-stub")).toBeNull();
  });

  it("switches to Диагностика and hides every other section's content", () => {
    render(<AppShell />);
    clickNav("Диагностика");
    expect(screen.getByRole("heading", { name: "Диагностика" })).toBeTruthy();
    expect(screen.queryByText("Состояние эфира")).toBeNull();
    expect(screen.queryByTestId("chat-page-stub")).toBeNull();
    expect(screen.queryByRole("heading", { name: "Настройки" })).toBeNull();
  });

  it("navigating back to Главная restores its content", () => {
    render(<AppShell />);
    clickNav("Диагностика");
    clickNav("Главная");
    expect(screen.getByText("Состояние эфира")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Диагностика" })).toBeNull();
  });
});

describe("AppShell post-split cleanup (Companion UI 2.0)", () => {
  it("Настройки hosts the companion token form, OBS scene mapping, and hotkeys", () => {
    render(<AppShell />);
    clickNav("Настройки");
    const settingsView = screen.getByRole("heading", { name: "Настройки" }).closest(".settings-view") as HTMLElement;
    expect(within(settingsView).getByText("Companion token")).toBeTruthy();
    expect(within(settingsView).getByRole("heading", { name: "Сцены OBS" })).toBeTruthy();
    expect(within(settingsView).getByRole("heading", { name: "Пропустить озвучку" })).toBeTruthy();
    expect(within(settingsView).getByText("Запускать Companion вместе с Windows")).toBeTruthy();
  });

  it("Диагностика no longer duplicates the companion token form, OBS scene mapping, or hotkeys", () => {
    render(<AppShell />);
    clickNav("Диагностика");
    expect(screen.queryByText("Companion token")).toBeNull();
    expect(screen.queryByRole("heading", { name: "Сцены OBS" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Пропустить озвучку" })).toBeNull();
  });

  it("Чат no longer hosts the hotkey controls (moved to Настройки)", () => {
    render(<AppShell />);
    clickNav("Чат");
    expect(screen.queryByRole("heading", { name: "Пропустить озвучку" })).toBeNull();
    expect(screen.queryByText("Включить горячую клавишу")).toBeNull();
  });
});

// Companion UI 2.0 follow-up (задача п.5) - "Stream controls must not
// depend on OBS/GSI". StreamSessionCard is rendered unconditionally at the
// top of Главная; these tests prove it stays fully functional across every
// OBS/GSI/wizard permutation.
describe("Stream session controls are independent of OBS/GSI/setup state", () => {
  it("End Stream is available with an active session even when OBS is disconnected and GSI has no signal", () => {
    statusFixture = buildStatusFixture({
      obs_connected: false,
      obs_state: "disconnected",
      gsi_state: "waiting",
    });
    sessionPromptFixture = buildSessionPromptFixture({ promptData: ACTIVE_SESSION });
    render(<AppShell />);
    expect(screen.getByText("Стрим идёт")).toBeTruthy();
    const endButton = screen.getByRole("button", { name: "Завершить стрим" }) as HTMLButtonElement;
    expect(endButton.disabled).toBe(false);
  });

  it("End Stream is available even when Dota/GSI was never configured at all", () => {
    statusFixture = buildStatusFixture({
      dota_found: false,
      gsi_installed: false,
      gsi_state: "waiting",
    });
    sessionPromptFixture = buildSessionPromptFixture({ promptData: ACTIVE_SESSION });
    render(<AppShell />);
    const endButton = screen.getByRole("button", { name: "Завершить стрим" }) as HTMLButtonElement;
    expect(endButton.disabled).toBe(false);
  });

  it("Start New is available for an ended session regardless of OBS/GSI state", () => {
    statusFixture = buildStatusFixture({ obs_connected: false, gsi_state: "waiting" });
    sessionPromptFixture = buildSessionPromptFixture({
      promptData: { ...ACTIVE_SESSION, state: "ended", endedAt: new Date().toISOString() },
    });
    render(<AppShell />);
    const startButton = screen.getByRole("button", { name: "Начать новый стрим" }) as HTMLButtonElement;
    expect(startButton.disabled).toBe(false);
  });

  it("the session card renders even while the first-run setup wizard is open", () => {
    localStorage.removeItem("companion-setup-complete");
    sessionPromptFixture = buildSessionPromptFixture({ promptData: ACTIVE_SESSION });
    render(<AppShell />);
    // Wizard is showing (readiness/status-grid from the normal view are
    // absent), but the session card and its End button are still there.
    expect(screen.queryByText("Состояние эфира")).toBeNull();
    expect(screen.getByText("Подготовим Companion к стриму")).toBeTruthy();
    expect(screen.getByText("Стрим идёт")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Завершить стрим" })).toBeTruthy();
  });

  it("clicking End Stream calls onEndStream even though OBS is disconnected (does not treat OBS state as a precondition)", () => {
    statusFixture = buildStatusFixture({ obs_connected: false });
    const onEndStream = vi.fn().mockResolvedValue(undefined);
    sessionPromptFixture = buildSessionPromptFixture({ promptData: ACTIVE_SESSION, onEndStream });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<AppShell />);

    fireEvent.click(screen.getByRole("button", { name: "Завершить стрим" }));

    expect(onEndStream).toHaveBeenCalledTimes(1);
    vi.restoreAllMocks();
  });
});
