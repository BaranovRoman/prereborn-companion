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
// sidebar, exactly one section's content is visible at a time, and the
// post-split cleanup actually happened (OBS mapping / companion token no
// longer duplicated into Диагностика).

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));

// A realistic, fully-populated status so ObsScenePanel (which renders
// nothing at all when status/config is null - see ObsScenePanel.tsx) has
// something real to show for the Настройки/Диагностика cleanup assertions
// below.
const STATUS_FIXTURE = {
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
};

vi.mock("../hooks/useStatus", () => ({
  useStatus: () => ({ status: STATUS_FIXTURE, setStatus: vi.fn(), refresh: vi.fn().mockResolvedValue(undefined) }),
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
  useStreamSessionPrompt: () => ({
    promptData: null,
    promptMode: "hidden",
    showPrompt: false,
    busy: false,
    error: null,
    onContinue: vi.fn(),
    onStartNew: vi.fn().mockResolvedValue(undefined),
    onEndStream: vi.fn().mockResolvedValue(undefined),
  }),
}));
vi.mock("../chat/useTwitchChatSession", () => ({ useTwitchChatSession: () => ({}) }));
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
  localStorage.setItem("companion-setup-complete", "true");
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
  it("Настройки hosts the companion token form and OBS scene mapping heading", () => {
    render(<AppShell />);
    clickNav("Настройки");
    const settingsView = screen.getByRole("heading", { name: "Настройки" }).closest(".settings-view") as HTMLElement;
    expect(within(settingsView).getByText("Companion token")).toBeTruthy();
    expect(within(settingsView).getByRole("heading", { name: "Сцены OBS" })).toBeTruthy();
    expect(within(settingsView).getByText("Запускать Companion вместе с Windows")).toBeTruthy();
  });

  it("Диагностика no longer duplicates the companion token form or OBS scene mapping", () => {
    render(<AppShell />);
    clickNav("Диагностика");
    expect(screen.queryByText("Companion token")).toBeNull();
    expect(screen.queryByRole("heading", { name: "Сцены OBS" })).toBeNull();
  });
});
