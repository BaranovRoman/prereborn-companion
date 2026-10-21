import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChangelogItem } from "@/entities/changelog/load";

vi.mock("next/font/google", () => ({ Inter: () => ({ className: "inter" }) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn(), refresh: vi.fn(), push: vi.fn() }) }));
vi.mock("@/shared/config/dota-companion", () => ({
  DOTA_COMPANION_VERSION: "9.8.7",
  DOTA_COMPANION_DOWNLOAD_URL: "https://github.com/BaranovRoman/prereborn-companion/releases/download/prereborn-v9.8.7/PreReborn.Companion_9.8.7_x64-setup.exe",
}));

import { LandingPage } from ".";

const plugins = [
  { id: "dota2", name: "Dota 2", description: "Игровые звуки по GSI.", version: "0.3.0" },
  { id: "newgame", name: "New Game", description: "", version: "1.0.0" },
];
const highlight: ChangelogItem = {
  product: { kind: "companion", id: "companion", name: "Companion" },
  version: "9.8.7", date: "2026-10-21", title: "Клипы", summary: "", sections: { "Новое": ["Клип по клавише."] },
};

describe("LandingPage", () => {
  beforeEach(() => { vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {}))); });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  it("downloads the build-time stable installer and shows its version", () => {
    render(<LandingPage catalog={{ ok: true, plugins }} highlight={highlight} />);
    for (const link of screen.getAllByRole("link", { name: /Скачать/ })) expect(link.getAttribute("href")).toMatch(/_x64-setup\.exe$/);
    expect(screen.getByText(/Версия 9\.8\.7 · Windows x64/)).toBeTruthy();
  });

  it("lists catalog plugins, including ones the site has no icon for", () => {
    render(<LandingPage catalog={{ ok: true, plugins }} highlight={null} />);
    const list = screen.getByRole("heading", { level: 2, name: "Игровые плагины" }).closest("section")!;
    expect(within(list).getByRole("heading", { name: "Dota 2" })).toBeTruthy();
    expect(within(list).getByRole("heading", { name: "New Game" })).toBeTruthy();
    expect(within(list).getByText("Версия 1.0.0")).toBeTruthy();
  });

  it("explains a catalog failure instead of inventing plugins", () => {
    render(<LandingPage catalog={{ ok: false }} highlight={null} />);
    expect(screen.getByText(/Не удалось загрузить каталог плагинов/)).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Последнее обновление" })).toBeNull();
  });

  it("highlights the latest update and links to the full history", () => {
    render(<LandingPage catalog={{ ok: true, plugins }} highlight={highlight} />);
    expect(screen.getByRole("heading", { name: "Клипы" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Вся история обновлений →" }).getAttribute("href")).toBe("/changelog");
  });

  it("keeps the existing auth routes reachable", async () => {
    render(<LandingPage catalog={{ ok: true, plugins }} highlight={null} />);
    expect((await screen.findAllByRole("link", { name: "Войти" }))[0].getAttribute("href")).toBe("/stream/login");
    expect(screen.getByRole("link", { name: "зарегистрируйтесь" }).getAttribute("href")).toBe("/stream/register");
  });
});
