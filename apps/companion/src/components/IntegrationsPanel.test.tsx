// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../services/dotaCompanionApi", () => ({
  getSteamIntegrationStatus: vi.fn(),
  disconnectSteam: vi.fn(),
  getTwitchIntegrationStatus: vi.fn(),
  connectTwitch: vi.fn(),
  disconnectTwitch: vi.fn(),
  getDonationAlertsIntegrationStatus: vi.fn(),
  connectDonationAlerts: vi.fn(),
  disconnectDonationAlerts: vi.fn(),
  openStreamSettings: vi.fn(),
}));

// eslint-disable-next-line import/order
import {
  connectDonationAlerts,
  connectTwitch,
  disconnectDonationAlerts,
  disconnectSteam,
  disconnectTwitch,
  getDonationAlertsIntegrationStatus,
  getSteamIntegrationStatus,
  getTwitchIntegrationStatus,
  openStreamSettings,
} from "../services/dotaCompanionApi";
// eslint-disable-next-line import/order
import { IntegrationsPanel } from "./IntegrationsPanel";

const mockedSteamStatus = vi.mocked(getSteamIntegrationStatus);
const mockedDisconnectSteam = vi.mocked(disconnectSteam);
const mockedTwitchStatus = vi.mocked(getTwitchIntegrationStatus);
const mockedConnectTwitch = vi.mocked(connectTwitch);
const mockedDisconnectTwitch = vi.mocked(disconnectTwitch);
const mockedDonationAlertsStatus = vi.mocked(getDonationAlertsIntegrationStatus);
const mockedConnectDonationAlerts = vi.mocked(connectDonationAlerts);
const mockedDisconnectDonationAlerts = vi.mocked(disconnectDonationAlerts);
const mockedOpenStreamSettings = vi.mocked(openStreamSettings);

const NOT_CONNECTED_TWITCH = { connected: false };
const NOT_CONNECTED_DONATION_ALERTS = { connected: false, configured: true };

beforeEach(() => {
  // DonationAlerts is a third row fetched unconditionally on mount; give
  // every test a safe default so tests that don't care about it don't need
  // their own override.
  mockedDonationAlertsStatus.mockResolvedValue(NOT_CONNECTED_DONATION_ALERTS);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("IntegrationsPanel - Steam (unchanged reference behavior)", () => {
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
});

// WK-149 - Twitch/DonationAlerts are no longer "manage on the website" rows:
// Companion now drives connect (opens the provider's redirectUrl in the
// system browser) and disconnect (hits the existing DELETE endpoint)
// directly, same UX shape as Steam above, just generic copy.
describe("IntegrationsPanel - Twitch (native connect/disconnect)", () => {
  it("disconnected Twitch shows [ Подключить ] and initiates connection from Companion", async () => {
    mockedSteamStatus.mockResolvedValue({ connected: false });
    mockedTwitchStatus.mockResolvedValue(NOT_CONNECTED_TWITCH);
    mockedConnectTwitch.mockResolvedValue(undefined);
    render(<IntegrationsPanel />);

    await waitFor(() => expect(screen.getByText("Twitch")).toBeTruthy());
    const twitchSection = within(screen.getByText("Twitch").closest("section") as HTMLElement);
    expect(twitchSection.queryByRole("button", { name: /сайте/ })).toBeNull();

    fireEvent.click(twitchSection.getByRole("button", { name: "Подключить" }));
    await waitFor(() => expect(mockedConnectTwitch).toHaveBeenCalledTimes(1));
    expect(mockedOpenStreamSettings).not.toHaveBeenCalled();
  });

  it("connected Twitch shows identity and can disconnect/manage from Companion", async () => {
    mockedSteamStatus.mockResolvedValue({ connected: false });
    mockedTwitchStatus.mockResolvedValue({ connected: true, displayName: "streamer_tv" });
    mockedDisconnectTwitch.mockResolvedValue(undefined);
    render(<IntegrationsPanel />);

    await waitFor(() => expect(screen.getByText("streamer_tv")).toBeTruthy());
    const twitchSection = within(screen.getByText("streamer_tv").closest("section") as HTMLElement);
    expect(twitchSection.queryByRole("button", { name: /сайте/ })).toBeNull();

    fireEvent.click(twitchSection.getByRole("button", { name: "Отключить" }));
    expect(twitchSection.getByText(/Чат и озвучка сообщений \(TTS\) станут недоступны/)).toBeTruthy();
    expect(mockedDisconnectTwitch).not.toHaveBeenCalled();

    mockedTwitchStatus.mockResolvedValue(NOT_CONNECTED_TWITCH);
    fireEvent.click(twitchSection.getByRole("button", { name: "Подтвердить отключение" }));
    await waitFor(() => expect(mockedDisconnectTwitch).toHaveBeenCalledTimes(1));
    await waitFor(() => {
      const refreshedTwitchSection = within(screen.getByText("Twitch").closest("section") as HTMLElement);
      expect(refreshedTwitchSection.getByRole("button", { name: "Подключить" })).toBeTruthy();
    });
  });

  it("a Twitch connect failure shows a per-row error without breaking Steam/DonationAlerts", async () => {
    mockedSteamStatus.mockResolvedValue({ connected: false });
    mockedTwitchStatus.mockResolvedValue(NOT_CONNECTED_TWITCH);
    mockedConnectTwitch.mockRejectedValue(new Error("provider unreachable"));
    render(<IntegrationsPanel />);

    await waitFor(() => expect(screen.getByText("Twitch")).toBeTruthy());
    const twitchSection = within(screen.getByText("Twitch").closest("section") as HTMLElement);
    fireEvent.click(twitchSection.getByRole("button", { name: "Подключить" }));

    await waitFor(() => expect(twitchSection.getByText(/Ошибка: Error: provider unreachable/)).toBeTruthy());
    // Steam row is unaffected.
    expect(screen.getByRole("button", { name: "Привязать Steam" })).toBeTruthy();
  });
});

describe("IntegrationsPanel - DonationAlerts (native connect/disconnect)", () => {
  it("disconnected DonationAlerts shows [ Подключить ] and initiates connection from Companion", async () => {
    mockedSteamStatus.mockResolvedValue({ connected: false });
    mockedTwitchStatus.mockResolvedValue(NOT_CONNECTED_TWITCH);
    mockedDonationAlertsStatus.mockResolvedValue(NOT_CONNECTED_DONATION_ALERTS);
    mockedConnectDonationAlerts.mockResolvedValue(undefined);
    render(<IntegrationsPanel />);

    await waitFor(() => expect(screen.getByText("DonationAlerts")).toBeTruthy());
    const section = within(screen.getByText("DonationAlerts").closest("section") as HTMLElement);
    fireEvent.click(section.getByRole("button", { name: "Подключить" }));
    await waitFor(() => expect(mockedConnectDonationAlerts).toHaveBeenCalledTimes(1));
  });

  it("connected DonationAlerts shows identity and can disconnect from Companion", async () => {
    mockedSteamStatus.mockResolvedValue({ connected: false });
    mockedTwitchStatus.mockResolvedValue(NOT_CONNECTED_TWITCH);
    mockedDonationAlertsStatus.mockResolvedValue({ connected: true, configured: true, displayName: "CoolStreamerRU" });
    mockedDisconnectDonationAlerts.mockResolvedValue(undefined);
    render(<IntegrationsPanel />);

    await waitFor(() => expect(screen.getByText("CoolStreamerRU")).toBeTruthy());
    expect(screen.getByText(/панели донатеров/)).toBeTruthy();
    const section = within(screen.getByText("CoolStreamerRU").closest("section") as HTMLElement);

    fireEvent.click(section.getByRole("button", { name: "Отключить" }));
    mockedDonationAlertsStatus.mockResolvedValue(NOT_CONNECTED_DONATION_ALERTS);
    fireEvent.click(section.getByRole("button", { name: "Подтвердить отключение" }));
    await waitFor(() => expect(mockedDisconnectDonationAlerts).toHaveBeenCalledTimes(1));
  });
});

describe("IntegrationsPanel - cross-cutting", () => {
  it("shows a quiet error state per-provider when a status fetch fails, without crashing the panel", async () => {
    mockedSteamStatus.mockRejectedValue(new Error("network down"));
    mockedTwitchStatus.mockResolvedValue(NOT_CONNECTED_TWITCH);
    render(<IntegrationsPanel />);

    await waitFor(() => expect(screen.getByText("Не удалось получить статус Steam.")).toBeTruthy());
    // Twitch section still renders normally alongside the failed Steam one
    // (the "used for" hint only shows once connected - see the connected-Twitch
    // test above; disconnected shows the connect hint instead).
    expect(await screen.findByText(/Подключение откроет страницу авторизации Twitch/)).toBeTruthy();
  });

  it("a DonationAlerts status failure shows a quiet per-row error without breaking Steam/Twitch", async () => {
    mockedSteamStatus.mockResolvedValue({ connected: false });
    mockedTwitchStatus.mockResolvedValue(NOT_CONNECTED_TWITCH);
    mockedDonationAlertsStatus.mockRejectedValue(new Error("network down"));
    render(<IntegrationsPanel />);

    await waitFor(() => expect(screen.getByText("Не удалось получить статус DonationAlerts.")).toBeTruthy());
    expect(screen.getByRole("button", { name: "Привязать Steam" })).toBeTruthy();
  });

  it("refetches all three provider statuses when the window regains focus (picks up a browser-completed link)", async () => {
    mockedSteamStatus.mockResolvedValue({ connected: false });
    mockedTwitchStatus.mockResolvedValue(NOT_CONNECTED_TWITCH);
    render(<IntegrationsPanel />);

    await waitFor(() => expect(mockedSteamStatus).toHaveBeenCalledTimes(1));
    expect(mockedTwitchStatus).toHaveBeenCalledTimes(1);
    expect(mockedDonationAlertsStatus).toHaveBeenCalledTimes(1);

    act(() => {
      window.dispatchEvent(new Event("focus"));
    });

    await waitFor(() => expect(mockedSteamStatus).toHaveBeenCalledTimes(2));
    expect(mockedTwitchStatus).toHaveBeenCalledTimes(2);
    expect(mockedDonationAlertsStatus).toHaveBeenCalledTimes(2);
  });
});
