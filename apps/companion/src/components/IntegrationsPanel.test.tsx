// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../services/dotaCompanionApi", () => ({
  getSteamIntegrationStatus: vi.fn(),
  disconnectSteam: vi.fn(),
  getTwitchIntegrationStatus: vi.fn(),
  getDonationAlertsIntegrationStatus: vi.fn(),
  openStreamSettings: vi.fn(),
}));

// eslint-disable-next-line import/order
import {
  disconnectSteam,
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
const mockedDonationAlertsStatus = vi.mocked(getDonationAlertsIntegrationStatus);
const mockedOpenStreamSettings = vi.mocked(openStreamSettings);

const NOT_CONNECTED_TWITCH = { connected: false };
const NOT_CONNECTED_DONATION_ALERTS = { connected: false, configured: true };

beforeEach(() => {
  // WK-133 follow-up - DonationAlerts is now a third row fetched
  // unconditionally on mount; give every test a safe default so tests that
  // don't care about it don't need their own override.
  mockedDonationAlertsStatus.mockResolvedValue(NOT_CONNECTED_DONATION_ALERTS);
});

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

  it("Twitch connected: shows identity and 'Управлять на сайте ↗' (no local OAuth)", async () => {
    mockedSteamStatus.mockResolvedValue({ connected: false });
    mockedTwitchStatus.mockResolvedValue({ connected: true, displayName: "streamer_tv" });
    render(<IntegrationsPanel />);

    await waitFor(() => expect(screen.getByText("streamer_tv")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Управлять на сайте ↗" }));
    expect(mockedOpenStreamSettings).toHaveBeenCalled();
  });

  // WK-133 visual review - "Управлять" implies an existing connection; a
  // not-connected provider must offer "Подключить" instead, never the
  // connected-state copy.
  it("Twitch not connected: shows 'Подключить на сайте ↗', never 'Управлять'", async () => {
    mockedSteamStatus.mockResolvedValue({ connected: false });
    mockedTwitchStatus.mockResolvedValue(NOT_CONNECTED_TWITCH);
    render(<IntegrationsPanel />);

    await waitFor(() => expect(screen.getByText("Twitch")).toBeTruthy());
    const twitchSection = within(screen.getByText("Twitch").closest("section") as HTMLElement);
    expect(twitchSection.getByRole("button", { name: "Подключить на сайте ↗" })).toBeTruthy();
    expect(twitchSection.queryByRole("button", { name: /^Управлять/ })).toBeNull();
    fireEvent.click(twitchSection.getByRole("button", { name: "Подключить на сайте ↗" }));
    expect(mockedOpenStreamSettings).toHaveBeenCalled();
  });

  // WK-133 follow-up - DonationAlerts was missed by the original audit: a
  // real existing account integration (OAuth-linked on the website),
  // already consumed by Companion's own overlay renderer. Status-only here,
  // same shape as Twitch.
  it("DonationAlerts connected: shows identity, current product use, and 'Управлять на сайте ↗'", async () => {
    mockedSteamStatus.mockResolvedValue({ connected: false });
    mockedTwitchStatus.mockResolvedValue(NOT_CONNECTED_TWITCH);
    mockedDonationAlertsStatus.mockResolvedValue({ connected: true, configured: true, displayName: "CoolStreamerRU" });
    render(<IntegrationsPanel />);

    await waitFor(() => expect(screen.getByText("CoolStreamerRU")).toBeTruthy());
    expect(screen.getByText(/панели донатеров/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Управлять на сайте ↗" }));
    expect(mockedOpenStreamSettings).toHaveBeenCalled();
  });

  it("DonationAlerts not connected: shows 'Подключить на сайте ↗'", async () => {
    mockedSteamStatus.mockResolvedValue({ connected: false });
    mockedTwitchStatus.mockResolvedValue(NOT_CONNECTED_TWITCH);
    mockedDonationAlertsStatus.mockResolvedValue(NOT_CONNECTED_DONATION_ALERTS);
    render(<IntegrationsPanel />);

    await waitFor(() => expect(screen.getByText("DonationAlerts")).toBeTruthy());
    const donationAlertsSection = within(screen.getByText("DonationAlerts").closest("section") as HTMLElement);
    expect(donationAlertsSection.getByRole("button", { name: "Подключить на сайте ↗" })).toBeTruthy();
  });

  it("a DonationAlerts status failure shows a quiet per-row error without breaking Steam/Twitch", async () => {
    mockedSteamStatus.mockResolvedValue({ connected: false });
    mockedTwitchStatus.mockResolvedValue(NOT_CONNECTED_TWITCH);
    mockedDonationAlertsStatus.mockRejectedValue(new Error("network down"));
    render(<IntegrationsPanel />);

    await waitFor(() => expect(screen.getByText("Не удалось получить статус DonationAlerts.")).toBeTruthy());
    expect(screen.getByRole("button", { name: "Привязать Steam" })).toBeTruthy();
  });

  it("shows a quiet error state per-provider when a status fetch fails, without crashing the panel", async () => {
    mockedSteamStatus.mockRejectedValue(new Error("network down"));
    mockedTwitchStatus.mockResolvedValue(NOT_CONNECTED_TWITCH);
    render(<IntegrationsPanel />);

    await waitFor(() => expect(screen.getByText("Не удалось получить статус Steam.")).toBeTruthy());
    // Twitch section still renders normally alongside the failed Steam one.
    expect(await screen.findByText("Используется для: чата и озвучки сообщений (TTS).")).toBeTruthy();
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
