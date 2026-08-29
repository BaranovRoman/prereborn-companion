// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../services/dotaCompanionApi", () => ({
  getAccountStatus: vi.fn(),
}));

// eslint-disable-next-line import/order
import { getAccountStatus } from "../services/dotaCompanionApi";
// eslint-disable-next-line import/order
import { DeviceCredentialPanel } from "./DeviceCredentialPanel";

const mockedStatus = vi.mocked(getAccountStatus);

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe("DeviceCredentialPanel", () => {
  it("shows 'active' when a session or legacy token is connected, never the credential itself", async () => {
    mockedStatus.mockResolvedValue({ connected: true, method: "session", email: "roma@example.com" });
    render(<DeviceCredentialPanel />);
    await waitFor(() => expect(screen.getByText(/active/)).toBeTruthy());
    expect(screen.queryByText("roma@example.com")).toBeNull();
  });

  it("shows 'missing' when there is no credential at all", async () => {
    mockedStatus.mockResolvedValue({ connected: false, method: "none", email: null });
    render(<DeviceCredentialPanel />);
    await waitFor(() => expect(screen.getByText(/missing/)).toBeTruthy());
  });

  it("falls back to 'missing' rather than throwing when the status call itself fails", async () => {
    mockedStatus.mockRejectedValue(new Error("no tauri runtime"));
    render(<DeviceCredentialPanel />);
    await waitFor(() => expect(screen.getByText(/missing/)).toBeTruthy());
  });
});
