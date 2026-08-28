// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// WK-114 - Old Dota Companion shell: a header (brand + gear + Главная/Чат/
// Звуки) replaces the old sidebar, Настройки moves from a nav page into a
// modal opened by the gear, Диагностика is reachable but secondary (not one
// of the 3 main tabs), and the legacy manual backend-session controls
// (WK-83/WK-100) move into Диагностика as a recovery/debug tool instead of
// living on Главная. These tests pin: the 3 main sections + Диагностика are
// all reachable, exactly one section's content is visible at a time, the
// gear opens/closes the Настройки modal without navigating away from the
// current section, ProblemBar only ever renders for a genuine problem, and -
// carried over from Companion UI 2.0 - stream session controls (now on
// Диагностика) never depend on OBS/GSI status.

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));

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
    backend_state: "connected",
    backend_last_sent_at: new Date().toISOString(),
    backend_last_error: null,
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
    obs_streaming: true,
    obs_manual_summary_active: false,
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
vi.mock("../hooks/useLocalLifecycle", () => ({
  useLocalLifecycle: () => ({ status: { session_state: "open", session_started_at: null, pending_end_at: null, obs_streaming: true }, busy: false, error: null, onContinue: vi.fn(), onEnd: vi.fn() }),
}));
vi.mock("../hooks/useLocalSessionSummary", () => ({
  useLocalSessionSummary: () => null,
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
vi.mock("../sounds/useGameSoundEngine", () => ({ useGameSoundEngine: () => ({}) }));
vi.mock("../pages/SoundsPage", () => ({
  SoundsPage: () => <div data-testid="sounds-page-stub">Sounds stub</div>,
}));

// eslint-disable-next-line import/order
import { AppShell } from "./AppShell";

const clickNav = (label: string) => {
  fireEvent.click(screen.getByRole("button", { name: new RegExp(label) }));
};

beforeEach(() => {
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
    expect(screen.getByText("Текущий MMR")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Главная/ }).className).toContain("is-active");
  });

  it("switches to Чат and hides Главная content", () => {
    render(<AppShell />);
    clickNav("Чат");
    expect(screen.getByTestId("chat-page-stub")).toBeTruthy();
    expect(screen.queryByText("Текущий MMR")).toBeNull();
    expect(screen.getByRole("button", { name: /Чат/ }).className).toContain("is-active");
  });

  it("switches to Звуки and hides every other section's content", () => {
    render(<AppShell />);
    clickNav("Звуки");
    expect(screen.getByTestId("sounds-page-stub")).toBeTruthy();
    expect(screen.queryByText("Текущий MMR")).toBeNull();
    expect(screen.queryByTestId("chat-page-stub")).toBeNull();
    expect(screen.getByRole("button", { name: /Звуки/ }).className).toContain("is-active");
  });

  it("switches to Диагностика (secondary link) and hides every other section's content", () => {
    render(<AppShell />);
    clickNav("Диагностика");
    expect(screen.getByRole("heading", { name: "Диагностика" })).toBeTruthy();
    expect(screen.queryByText("Текущий MMR")).toBeNull();
    expect(screen.queryByTestId("chat-page-stub")).toBeNull();
  });

  it("navigating back to Главная restores its content", () => {
    render(<AppShell />);
    clickNav("Диагностика");
    clickNav("Главная");
    expect(screen.getByText("Текущий MMR")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Диагностика" })).toBeNull();
  });

  it("Настройки is not one of the main nav tabs (only the gear button, outside the nav, is named that)", () => {
    render(<AppShell />);
    const nav = screen.getByRole("navigation", { name: "Разделы приложения" });
    expect(within(nav).queryByRole("button", { name: /Настройки/ })).toBeNull();
  });
});

describe("AppShell Настройки modal (gear icon)", () => {
  it("is closed by default and opens via the gear button, hosting the token form, OBS scene mapping, and hotkeys", () => {
    render(<AppShell />);
    expect(screen.queryByRole("dialog", { name: "Настройки" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Настройки" }));
    const modal = screen.getByRole("dialog", { name: "Настройки" });
    expect(within(modal).getByText("Companion token")).toBeTruthy();

    fireEvent.click(within(modal).getByRole("button", { name: "OBS" }));
    expect(within(modal).getByRole("heading", { name: "Сцены OBS" })).toBeTruthy();

    fireEvent.click(within(modal).getByRole("button", { name: "Горячие клавиши" }));
    expect(within(modal).getByRole("heading", { name: "Пропустить озвучку" })).toBeTruthy();
  });

  it("closes via the close button without changing the active main section", () => {
    render(<AppShell />);
    fireEvent.click(screen.getByRole("button", { name: "Настройки" }));
    fireEvent.click(screen.getByRole("button", { name: "Закрыть настройки" }));
    expect(screen.queryByRole("dialog", { name: "Настройки" })).toBeNull();
    expect(screen.getByText("Текущий MMR")).toBeTruthy();
  });

  it("closes via Escape", () => {
    render(<AppShell />);
    fireEvent.click(screen.getByRole("button", { name: "Настройки" }));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Настройки" })).toBeNull();
  });

  it("Диагностика no longer duplicates the companion token form, OBS scene mapping, or hotkeys", () => {
    render(<AppShell />);
    clickNav("Диагностика");
    expect(screen.queryByText("Companion token")).toBeNull();
    expect(screen.queryByRole("heading", { name: "Сцены OBS" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Пропустить озвучку" })).toBeNull();
  });

  it("Чат no longer hosts the hotkey controls (moved to the Настройки modal)", () => {
    render(<AppShell />);
    clickNav("Чат");
    expect(screen.queryByRole("heading", { name: "Пропустить озвучку" })).toBeNull();
    expect(screen.queryByText("Включить горячую клавишу")).toBeNull();
  });
});

// WK-114 - manual backend-session controls (WK-83/WK-100) moved from
// Главная to a collapsed section inside Диагностика (recovery/debug home) -
// no longer front-and-center, but still fully functional regardless of OBS/
// GSI status per задача п.5's original guarantee.
describe("Stream session controls (Диагностика) are independent of OBS/GSI/setup state", () => {
  it("End Stream is available with an active session even when OBS is disconnected and GSI has no signal", () => {
    statusFixture = buildStatusFixture({ obs_connected: false, obs_state: "unavailable", gsi_state: "waiting" });
    sessionPromptFixture = buildSessionPromptFixture({ promptData: ACTIVE_SESSION });
    render(<AppShell />);
    clickNav("Диагностика");
    fireEvent.click(screen.getByText("Ручное управление сессией (резерв на backend)"));
    expect(screen.getByText("Стрим идёт")).toBeTruthy();
    const endButton = screen.getByRole("button", { name: "Завершить стрим" }) as HTMLButtonElement;
    expect(endButton.disabled).toBe(false);
  });

  it("Start New is available for an ended session regardless of OBS/GSI state", () => {
    statusFixture = buildStatusFixture({ obs_connected: false, gsi_state: "waiting" });
    sessionPromptFixture = buildSessionPromptFixture({
      promptData: { ...ACTIVE_SESSION, state: "ended", endedAt: new Date().toISOString() },
    });
    render(<AppShell />);
    clickNav("Диагностика");
    fireEvent.click(screen.getByText("Ручное управление сессией (резерв на backend)"));
    const startButton = screen.getByRole("button", { name: "Начать новый стрим" }) as HTMLButtonElement;
    expect(startButton.disabled).toBe(false);
  });

  it("clicking End Stream calls onEndStream even though OBS is disconnected (does not treat OBS state as a precondition)", () => {
    statusFixture = buildStatusFixture({ obs_connected: false });
    const onEndStream = vi.fn().mockResolvedValue(undefined);
    sessionPromptFixture = buildSessionPromptFixture({ promptData: ACTIVE_SESSION, onEndStream });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<AppShell />);
    clickNav("Диагностика");
    fireEvent.click(screen.getByText("Ручное управление сессией (резерв на backend)"));

    fireEvent.click(screen.getByRole("button", { name: "Завершить стрим" }));

    expect(onEndStream).toHaveBeenCalledTimes(1);
    vi.restoreAllMocks();
  });
});

// WK-114 - ProblemBar: replaces the permanent status-grid cards. A fully
// healthy snapshot must render no problem chrome at all under the header;
// a genuine, sustained problem on any of the 3 sources must be visible.
describe("ProblemBar (Главная)", () => {
  it("renders nothing when GSI/OBS/backend are all connected", () => {
    render(<AppShell />);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("shows a GSI problem bar only once signal has been lost (recovering), not while merely waiting for Dota to launch", () => {
    statusFixture = buildStatusFixture({ gsi_state: "waiting" });
    render(<AppShell />);
    expect(screen.queryByText("Нет сигнала Dota")).toBeNull();

    cleanup();
    statusFixture = buildStatusFixture({ gsi_state: "recovering" });
    render(<AppShell />);
    expect(screen.getByText("Нет сигнала Dota")).toBeTruthy();
  });

  it("shows an OBS problem bar when OBS is unavailable", () => {
    statusFixture = buildStatusFixture({ obs_connected: false, obs_state: "unavailable", obs_last_error: "connection refused" });
    render(<AppShell />);
    expect(screen.getByText("OBS не подключён")).toBeTruthy();
    expect(screen.getByText("connection refused")).toBeTruthy();
  });

  it("shows the backend/sync problem bar as a non-blocking warning when the backend is unavailable", () => {
    statusFixture = buildStatusFixture({ backend_state: "unavailable", backend_last_error: "503" });
    render(<AppShell />);
    const bar = screen.getByText("PreReborn недоступен").closest(".problem-bar");
    expect(bar?.className).toContain("problem-bar--warning");
    expect(bar?.className).not.toContain("problem-bar--error");
  });

  it("multiple simultaneous problems all render without hiding one another", () => {
    statusFixture = buildStatusFixture({ gsi_state: "recovering", obs_state: "unavailable", obs_connected: false, backend_state: "unavailable" });
    render(<AppShell />);
    expect(screen.getByText("Нет сигнала Dota")).toBeTruthy();
    expect(screen.getByText("OBS не подключён")).toBeTruthy();
    expect(screen.getByText("PreReborn недоступен")).toBeTruthy();
  });
});
