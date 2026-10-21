// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("./api", async (original) => ({ ...(await original<typeof import("./api")>()), invoke: mocks.invoke }));
vi.mock("../../../protocol/ui", () => ({ client: () => ({ connection: Promise.resolve(), invoke: vi.fn() }) }));
import { Pubg } from "./App";

const widget = { enabled: false, count: 5, scale: 100, backgroundOpacity: 70, showHeaders: true };
const status = (patch: Record<string, unknown> = {}) => ({
  prepared: true, active: true, configured: true, player: "ProPlayer", platform: "steam", sessionStartedAt: "2026-10-21T18:00:00Z",
  apiStatus: "ok", lastError: null, lastFetchAt: null, fetching: false, matches: 2, sessionMatches: 1, revision: 3,
  widget: { enabled: false, url: "http://127.0.0.1:3667/pubg/widget", error: null, running: true, clients: 0 }, ...patch,
});
const matches = {
  revision: 3, sessionStartedAt: "2026-10-21T18:00:00Z", sessionIds: ["m2"],
  matches: [
    { id: "m2", createdAt: "2026-10-21T19:00:00Z", durationSec: 1800, map: "Miramar", gameMode: "squad-fpp", place: 1, kills: 8, damage: 970 },
    { id: "m1", createdAt: "2026-10-21T17:00:00Z", durationSec: 1700, map: "Erangel", gameMode: "solo", place: 17, kills: 2, damage: 285 },
  ],
};
let current = status();
let saved: unknown[] = [];
// What the worker has on disk: settings.get reads it back, like a reopened tab.
let stored: Record<string, unknown> = {};
beforeEach(() => {
  current = status(); saved = []; stored = { player: "ProPlayer", platform: "steam", widget };
  mocks.invoke.mockImplementation(async (name: string, args?: { settings: unknown }) => {
    if (name === "status") return current;
    if (name === "matches") return matches;
    if (name === "settings.get") return { settings: stored, widgetUrl: "http://127.0.0.1:3667/pubg/widget" };
    if (name === "settings.save") { saved.push(args!.settings); stored = args!.settings as Record<string, unknown>; return { settings: stored, status: current }; }
    return {};
  });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe("installed PUBG package UI", () => {
  it("lists matches with map, place, kills, damage and marks the current session", async () => {
    render(<Pubg />);
    const table = await screen.findByRole("table", { name: "Матчи PUBG" });
    const rows = within(table).getAllByRole("row");
    expect(rows).toHaveLength(3);
    expect(rows[1].textContent).toContain("Miramar");
    expect(rows[1].textContent).toContain("#1");
    expect(rows[1].textContent).toContain("Отряды FPP");
    expect(within(rows[1]).getByText("Сессия")).toBeTruthy();
    expect(within(rows[2]).queryByText("Сессия")).toBeNull();
    expect(screen.getByRole("status").textContent).toContain("матчей в сессии: 1");
  });

  it("explains API problems without treating them as plugin failure", async () => {
    current = status({ apiStatus: "player_not_found" });
    render(<Pubg />);
    expect(await screen.findByText(/Игрок не найден/)).toBeTruthy();
    current = status({ apiStatus: "not_configured" });
    cleanup(); render(<Pubg />);
    expect(await screen.findByText(/ещё не подключён к PUBG API/)).toBeTruthy();
  });

  it("saves a valid nickname and platform and rejects an invalid one", async () => {
    render(<Pubg />);
    await screen.findByRole("table", { name: "Матчи PUBG" });
    fireEvent.click(screen.getByRole("button", { name: "Игрок" }));
    const nick = screen.getByRole("textbox");
    fireEvent.change(nick, { target: { value: "bad name!" } });
    expect((screen.getByRole("button", { name: "Сохранить" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(nick, { target: { value: " New_Player " } });
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "xbox" } });
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
    await waitFor(() => expect(saved).toEqual([{ player: "New_Player", platform: "xbox", widget }]));
  });

  it("configures the OBS widget inside the plugin and previews session matches", async () => {
    render(<Pubg />);
    await screen.findByRole("table", { name: "Матчи PUBG" });
    fireEvent.click(screen.getByRole("button", { name: "OBS-виджет" }));
    expect(screen.getByText("http://127.0.0.1:3667/pubg/widget")).toBeTruthy();
    const preview = screen.getByRole("table", { name: "Матчи сессии PUBG" });
    expect(within(preview).getAllByRole("row")).toHaveLength(2);
    fireEvent.click(screen.getByRole("switch", { name: "Показывать виджет" }));
    await waitFor(() => expect(saved[saved.length - 1]).toMatchObject({ widget: { enabled: true } }));
    fireEvent.click(screen.getByRole("switch", { name: "Заголовки колонок" }));
    await waitFor(() => expect(saved[saved.length - 1]).toMatchObject({ widget: { showHeaders: false } }));
  });

  it("asks for a nickname first when none is set", async () => {
    mocks.invoke.mockImplementation(async (name: string) => {
      if (name === "settings.get") return { settings: { player: "", platform: "steam", widget } };
      if (name === "status") return status({ configured: false, player: "" });
      if (name === "matches") return { ...matches, matches: [], sessionIds: [] };
      return {};
    });
    render(<Pubg />);
    expect(await screen.findByRole("textbox")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain("Укажите ник");
  });
});

// WK-183 0.1.0 bug, reproduced as on Windows: the plugin iframe is sandboxed
// without allow-forms, so the browser never fires `submit`. Every test here
// blocks submit events before React sees them, the way that sandbox does.
describe("saving the player inside the sandboxed plugin frame", () => {
  const blockSubmit = (e: Event) => { e.preventDefault(); e.stopImmediatePropagation(); };
  beforeEach(() => window.addEventListener("submit", blockSubmit, true));
  afterEach(() => window.removeEventListener("submit", blockSubmit, true));
  const openPlayer = async () => {
    render(<Pubg />);
    await screen.findByRole("table", { name: "Матчи PUBG" });
    fireEvent.click(screen.getByRole("button", { name: "Игрок" }));
  };

  it("nickname and platform survive save → another tab → back, read from the worker", async () => {
    stored = { player: "", platform: "steam", widget };
    current = status({ configured: false, player: "" });
    render(<Pubg />);
    const nick = await screen.findByRole("textbox");
    fireEvent.change(nick, { target: { value: "New_Player" } });
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "xbox" } });
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
    await waitFor(() => expect(saved).toEqual([{ player: "New_Player", platform: "xbox", widget }]));
    expect(screen.getByText(/^Сохранено\./)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Матчи" }));
    fireEvent.click(screen.getByRole("button", { name: "Игрок" }));
    expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe("New_Player");
    expect((screen.getByRole("combobox") as HTMLSelectElement).value).toBe("xbox");
    // A fresh plugin UI (Companion restart) reads the same values back.
    cleanup();
    render(<Pubg />);
    fireEvent.click(await screen.findByRole("button", { name: "Игрок" }));
    expect(((await screen.findByRole("textbox")) as HTMLInputElement).value).toBe("New_Player");
  });

  it("Enter in the nickname field saves too", async () => {
    await openPlayer();
    const nick = screen.getByRole("textbox");
    fireEvent.change(nick, { target: { value: "Enter_Player" } });
    fireEvent.keyDown(nick, { key: "Enter" });
    await waitFor(() => expect(saved).toEqual([{ player: "Enter_Player", platform: "steam", widget }]));
  });

  it("a failed save shows the error, keeps the typed value and never claims «Сохранено»", async () => {
    const previous = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation(async (name: string, args?: unknown) => name === "settings.save" ? Promise.reject(new Error("plugin_data_write_failed: PUBG command failed")) : previous(name, args));
    await openPlayer();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Lost_Player" } });
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Не сохранено: не удалось записать файл настроек плагина.");
    expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe("Lost_Player");
    expect(screen.queryByText(/Сохранено/)).toBeNull();
  });

  it("a reply that does not match the request is not treated as saved", async () => {
    const previous = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation(async (name: string, args?: unknown) => name === "settings.save" ? { settings: { player: "ProPlayer", platform: "steam", widget }, status: current } : previous(name, args));
    await openPlayer();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Other_Player" } });
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
    expect((await screen.findByRole("alert")).textContent).toContain("плагин не подтвердил сохранение");
    expect(screen.queryByText(/Сохранено/)).toBeNull();
  });

  it("tells a stopped plugin to be enabled instead of promising matches", async () => {
    current = status({ active: false });
    await openPlayer();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Idle_Player" } });
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
    expect(await screen.findByText(/Сохранено\. Включите плагин/)).toBeTruthy();
  });
});

