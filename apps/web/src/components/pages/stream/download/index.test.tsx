import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// WK-95 - StreamDownloadPage reads DOTA_COMPANION_VERSION/DOWNLOAD_URL as
// module-level constants (frozen at import time from
// NEXT_PUBLIC_DOTA_COMPANION_*), so exercising both the "resolved" and
// "unresolved" states means mocking the shared config module per test
// rather than mutating process.env (which wouldn't be re-read anyway).
const mockCompanionConfig = (overrides: { version: string | null; downloadUrl: string | null }) => {
    vi.doMock("@/shared/config/dota-companion", () => ({
        DOTA_COMPANION_VERSION: overrides.version,
        DOTA_COMPANION_DOWNLOAD_URL: overrides.downloadUrl,
    }));
};

afterEach(() => {
    cleanup();
    vi.resetModules();
    vi.doUnmock("@/shared/config/dota-companion");
});

describe("StreamDownloadPage", () => {
    it("renders the download UI (title, version, install button) once the release is resolved - no auth/session gate", async () => {
        mockCompanionConfig({ version: "0.5.23", downloadUrl: "https://github.com/example/releases/download/prereborn-v0.5.23/setup.exe" });
        const { StreamDownloadPage } = await import("./index");
        render(<StreamDownloadPage />);

        expect(screen.getByText("PreReborn Companion")).toBeTruthy();
        expect(screen.getByText(/Версия 0\.5\.23/)).toBeTruthy();
        const button = screen.getByRole("link", { name: /Скачать для Windows/ });
        expect(button.getAttribute("href")).toBe(
            "https://github.com/example/releases/download/prereborn-v0.5.23/setup.exe"
        );
    });

    it("never hardcodes a version - a different resolved release shows that release, not a stale one", async () => {
        mockCompanionConfig({ version: "0.9.1", downloadUrl: "https://example.com/setup.exe" });
        const { StreamDownloadPage } = await import("./index");
        render(<StreamDownloadPage />);

        expect(screen.getByText(/Версия 0\.9\.1/)).toBeTruthy();
        expect(screen.queryByText(/0\.5\.23/)).toBeNull();
    });

    it("falls back to a clear 'installer is on its way' state instead of an empty page when the release isn't resolved", async () => {
        mockCompanionConfig({ version: null, downloadUrl: null });
        const { StreamDownloadPage } = await import("./index");
        render(<StreamDownloadPage />);

        // Still a real page, not blank: title/description always render.
        expect(screen.getByText("PreReborn Companion")).toBeTruthy();
        expect(screen.getByText(/desktop-приложение для Windows/i)).toBeTruthy();

        // No version line at all rather than a broken "Версия null".
        expect(screen.queryByText(/Версия/)).toBeNull();

        const button = screen.getByRole("button", { name: /Скоро — установщик готовится/ });
        expect(button.hasAttribute("disabled")).toBe(true);
    });

    it("does not require a stream account - regression guard for the auth-gate root cause", async () => {
        // No @/entities/stream-user mock at all: if the component ever
        // reintroduces useStreamSession(), this import would throw (the
        // hook reaches into streamAuthApi/localStorage) instead of quietly
        // rendering - the previous bug's failure mode.
        mockCompanionConfig({ version: "0.5.23", downloadUrl: "https://example.com/setup.exe" });
        const { StreamDownloadPage } = await import("./index");
        expect(() => render(<StreamDownloadPage />)).not.toThrow();
        expect(screen.getByText("PreReborn Companion")).toBeTruthy();
    });
});
