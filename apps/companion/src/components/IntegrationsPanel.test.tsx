// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../services/dotaCompanionApi", () => ({
  getSteamIntegrationStatus: vi.fn(),
  disconnectSteam: vi.fn(),
  getTwitchIntegrationStatus: vi.fn(),
  openStreamSettings: vi.fn(),
}));

// eslint-disable-next-line import/order
import {
  disconnectSteam,
  getSteamIntegrationStatus,
  getTwitchIntegrationStatus,
  openStreamSettings,
} from "../services/dotaCompanionApi";
// eslint-disable-next-line import/order
import { IntegrationsPanel } from "./IntegrationsPanel";

const mockedSteamStatus = vi.mocked(getSteamIntegrationStatus);
const mockedDisconnectSteam = vi.mocked(disconnectSteam);
const mockedTwitchStatus = vi.mocked(getTwitchIntegrationStatus);
const mockedOpenStreamSettings = vi.mocked(openStreamSettings);

const NOT_CONNECTED_TWITCH = { connected: false };

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("IntegrationsPanel", () => {
  it("shows a Steam link action and no identity when not connected", async () => {
    mockedSteamStatus.mockResolvedValue({ connected: false });
    mockedTwitchStatus.mockResolvedValue(NOT_CONNECTED_TWITCH);
    render(<IntegrationsPanel />);

    await waitFor(() => expect(screen.getByRole("button", { name: "Привязать Steam" })).toBeTruthy());
    expect(screen.getAllByText("Не подключено").length).toBeGreaterThan(0);
  });

  it("clicking Привязать Steam opens the existing web /stream flow, not a new auth implementation", async () => {
    mockedSteamStatus.mockResolvedValue({ connected: false });
    mockedTwitchStatus.mockResolvedValue(NOT_CONNECTED_TWITCH);
    mockedOpenStreamSettings.mockResolvedValue(undefined);
    render(<IntegrationsPanel />);

    await waitFor(() => expect(screen.getByRole("button", { name: "Привязать Steam" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Привязать Steam" }));
    await waitFor(() => expect(mockedOpenStreamSettings).toHaveBeenCalledTimes(1));
  });

  it("shows the linked Steam identity and what it's used for", async () => {
    mockedSteamStatus.mockResolvedValue({
      connected: true,
      steamId64: "76561198000000000",
      profile: { displayName: "CoolStreamer", avatarUrl: null, profileUrl: null },
    });
    mockedTwitchStatus.mockResolvedValue(NOT_CONNECTED_TWITCH);
    render(<IntegrationsPanel />);

    await waitFor(() => expect(screen.getByText("CoolStreamer")).toBeTruthy());
    expect(screen.getByText(/OpenDota/)).toBeTruthy();
  });

  it("falls back to the raw SteamID when no profile display name is available", async () => {
    mockedSteamStatus.mockResolvedValue({ connected: true, steamId64: "76561198000000000", profile: null });
    mockedTwitchStatus.mockResolvedValue(NOT_CONNECTED_TWITCH);
    render(<IntegrationsPanel />);

    await waitFor(() => expect(screen.getByText("SteamID 76561198000000000")).toBeTruthy());
  });

  it("unlinking Steam requires an explicit confirmation step and explains the consequence", async () => {
    mockedSteamStatus.mockResolvedValue({
      connected: true,
      steamId64: "1",
      profile: { displayName: "Streamer", avatarUrl: null, profileUrl: null },
    });
    mockedTwitchStatus.mockResolvedValue(NOT_CONNECTED_TWITCH);
    mockedDisconnectSteam.mockResolvedValue(undefined);
    render(<IntegrationsPanel />);

    await waitFor(() => expect(screen.getByRole("button", { name: "Отвязать" })).toBeTruthy());
    expect(mockedDisconnectSteam).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Отвязать" }));
    expect(screen.getByText(/Локальная история Companion, GSI, OBS и MMR не затрагиваются/)).toBeTruthy();
    expect(mockedDisconnectSteam).not.toHaveBeenCalled();

    mockedSteamStatus.mockResolvedValue({ connected: false });
    fireEvent.click(screen.getByRole("button", { name: "Подтвердить отвязку" }));

    await waitFor(() => expect(mockedDisconnectSteam).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByRole("button", { name: "Привязать Steam" })).toBeTruthy());
  });

  it("Отмена during unlink confirmation leaves the account linked", async () => {
    mockedSteamStatus.mockResolvedValue({ connected: true, steamId64: "1", profile: null });
    mockedTwitchStatus.mockResolvedValue(NOT_CONNECTED_TWITCH);
    render(<IntegrationsPanel />);

    await waitFor(() => expect(screen.getByRole("button", { name: "Отвязать" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Отвязать" }));
    fireEvent.click(screen.getByRole("button", { name: "Отмена" }));

    expect(mockedDisconnectSteam).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Отвязать" })).toBeTruthy();
  });

  it("shows Twitch connection status and a link to manage it on the website (no local OAuth)", async () => {
    mockedSteamStatus.mockResolvedValue({ connected: false });
    mockedTwitchStatus.mockResolvedValue({ connected: true, displayName: "streamer_tv" });
    render(<IntegrationsPanel />);

    await waitFor(() => expect(screen.getByText("streamer_tv")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Управлять на сайте" }));
    expect(mockedOpenStreamSettings).toHaveBeenCalled();
  });

  it("shows a quiet error state per-provider when a status fetch fails, without crashing the panel", async () => {
    mockedSteamStatus.mockRejectedValue(new Error("network down"));
    mockedTwitchStatus.mockResolvedValue(NOT_CONNECTED_TWITCH);
    render(<IntegrationsPanel />);

    await waitFor(() => expect(screen.getByText("Не удалось получить статус Steam.")).toBeTruthy());
    // Twitch section still renders normally alongside the failed Steam one.
    expect(await screen.findByText("Используется для: чата и озвучки сообщений (TTS).")).toBeTruthy();
  });

  it("refetches both provider statuses when the window regains focus (picks up a browser-completed Steam link)", async () => {
    mockedSteamStatus.mockResolvedValue({ connected: false });
    mockedTwitchStatus.mockResolvedValue(NOT_CONNECTED_TWITCH);
    render(<IntegrationsPanel />);

    await waitFor(() => expect(mockedSteamStatus).toHaveBeenCalledTimes(1));
    expect(mockedTwitchStatus).toHaveBeenCalledTimes(1);

    act(() => {
      window.dispatchEvent(new Event("focus"));
    });

    await waitFor(() => expect(mockedSteamStatus).toHaveBeenCalledTimes(2));
    expect(mockedTwitchStatus).toHaveBeenCalledTimes(2);
  });
});
