// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SoundsPage } from "./SoundsPage";
import type {
  GameSoundCatalog, GameSoundSettings, TrackedHero, TrackedItem,
} from "../services/dotaCompanionApi";
import type { useGameSoundEngine } from "../sounds/useGameSoundEngine";

const UNSUPPORTED_ITEM: TrackedItem = {
  id: "item_yasha",
  displayName: "Yasha",
  iconUrl: "https://example.com/yasha.png",
  supported: false,
  signal: null,
  reason: "Предмет без активного эффекта.",
};
const SUPPORTED_ITEM: TrackedItem = {
  id: "item_blink",
  displayName: "Blink Dagger",
  iconUrl: "https://example.com/blink.png",
  supported: true,
  signal: "cooldown",
  reason: null,
};
const CONFIGURED_ITEM: TrackedItem = {
  id: "item_tango",
  displayName: "Tango",
  iconUrl: "https://example.com/tango.png",
  supported: true,
  signal: "chargesOrConsumed",
  reason: null,
};

const HERO: TrackedHero = {
  id: "npc_dota_hero_pudge",
  displayName: "Pudge",
  iconUrl: "https://example.com/pudge.png",
  abilities: [
    { id: "pudge_meat_hook", displayName: "Meat Hook", iconUrl: "https://example.com/hook.png", supported: true, signal: "cooldown", toggleActiveAlias: null, reason: null },
    { id: "pudge_rot", displayName: "Rot", iconUrl: "https://example.com/rot.png", supported: false, signal: null, toggleActiveAlias: null, reason: "Тоггл-способность без кулдауна." },
  ],
};

const CATALOG: GameSoundCatalog = { items: [UNSUPPORTED_ITEM, SUPPORTED_ITEM, CONFIGURED_ITEM], heroes: [HERO] };

const buildSettings = (overrides: Partial<GameSoundSettings> = {}): GameSoundSettings => ({
  schemaVersion: 1,
  enabled: true,
  masterVolume: 65,
  bindings: [{ eventId: "item_tango", kind: "itemUsed", assetId: "asset-1" }],
  assets: [{ id: "asset-1", fileName: "asset-1.wav", originalName: "chomp.wav", sizeBytes: 10 }],
  ...overrides,
});

function buildEngine(overrides: Partial<ReturnType<typeof useGameSoundEngine>> = {}): ReturnType<typeof useGameSoundEngine> {
  return {
    catalog: CATALOG,
    settings: buildSettings(),
    error: null,
    setMaster: vi.fn().mockResolvedValue(undefined),
    setBinding: vi.fn().mockResolvedValue(undefined),
    removeBinding: vi.fn().mockResolvedValue(undefined),
    chooseAndBindFile: vi.fn().mockResolvedValue(undefined),
    preview: vi.fn().mockResolvedValue(undefined),
    stopPreview: vi.fn(),
    ...overrides,
  };
}

afterEach(() => cleanup());

describe("SoundsPage - Предметы", () => {
  it("shows three visually distinct item states", () => {
    render(<SoundsPage engine={buildEngine()} />);
    const unsupported = screen.getByTitle(/Yasha:/);
    expect(unsupported.className).toContain("sound-tile--unsupported");
    expect((unsupported as HTMLButtonElement).disabled).toBe(true);

    const blink = screen.getByTitle("Blink Dagger");
    expect(blink.className).toContain("sound-tile--supported");
    expect((blink as HTMLButtonElement).disabled).toBe(false);

    const tango = screen.getByTitle("Tango");
    expect(tango.className).toContain("sound-tile--configured");
  });

  it("clicking a supported item opens its sound modal", () => {
    render(<SoundsPage engine={buildEngine()} />);
    fireEvent.click(screen.getByTitle("Blink Dagger"));
    const modal = screen.getByRole("dialog");
    expect(within(modal).getByText("Blink Dagger")).toBeTruthy();
    expect(within(modal).getByText("Использование предмета")).toBeTruthy();
  });

  it("clicking an unsupported item does not open a modal", () => {
    render(<SoundsPage engine={buildEngine()} />);
    fireEvent.click(screen.getByTitle(/Yasha/));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("the configured item's modal shows the bound file and lets you remove it", async () => {
    const engine = buildEngine();
    render(<SoundsPage engine={engine} />);
    fireEvent.click(screen.getByTitle("Tango"));
    const modal = screen.getByRole("dialog");
    expect(within(modal).getByText("chomp.wav")).toBeTruthy();

    fireEvent.click(within(modal).getByRole("button", { name: "Удалить звук" }));
    expect(engine.removeBinding).toHaveBeenCalledWith("item_tango");
  });

  it("choosing a file imports and binds it to the event in one atomic step", async () => {
    const engine = buildEngine();
    render(<SoundsPage engine={engine} />);
    fireEvent.click(screen.getByTitle("Blink Dagger"));
    const modal = screen.getByRole("dialog");

    fireEvent.click(within(modal).getByRole("button", { name: "Выбрать файл" }));
    await Promise.resolve();
    await Promise.resolve();

    expect(engine.chooseAndBindFile).toHaveBeenCalledWith("item_blink", "itemUsed");
  });

  it("preview is disabled until a sound is bound", () => {
    render(<SoundsPage engine={buildEngine()} />);
    fireEvent.click(screen.getByTitle("Blink Dagger"));
    const modal = screen.getByRole("dialog");
    expect((within(modal).getByRole("button", { name: "Прослушать" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("SoundsPage - Герои", () => {
  it("switches to the Героев tab, searches, and opens the ability modal", () => {
    render(<SoundsPage engine={buildEngine()} />);
    fireEvent.click(screen.getByRole("button", { name: "Герои" }));
    expect(screen.getByTitle("Pudge")).toBeTruthy();

    fireEvent.change(screen.getByPlaceholderText("Поиск героя…"), { target: { value: "nothing-matches" } });
    expect(screen.queryByTitle("Pudge")).toBeNull();
    expect(screen.getByText("Герой не найден.")).toBeTruthy();

    fireEvent.change(screen.getByPlaceholderText("Поиск героя…"), { target: { value: "pud" } });
    fireEvent.click(screen.getByTitle("Pudge"));

    const modal = screen.getByRole("dialog");
    expect(within(modal).getByText("Meat Hook")).toBeTruthy();
    expect(within(modal).getByText("Rot")).toBeTruthy();
    expect(within(modal).getByText("Тоггл-способность без кулдауна.")).toBeTruthy();
    // Rot has no binding controls at all - only the unsupported label.
    expect(within(modal).getByText("Недоступно для отслеживания")).toBeTruthy();
  });
});

describe("SoundsPage - master controls", () => {
  it("reflects the enabled toggle and current volume, independent of TTS settings", () => {
    render(<SoundsPage engine={buildEngine({ settings: buildSettings({ enabled: false, masterVolume: 30 }) })} />);
    expect((screen.getByLabelText("Звуковые реакции") as HTMLInputElement).checked).toBe(false);
    expect(screen.getByText("30%")).toBeTruthy();
  });

  it("toggling the master switch calls setMaster with the toggled value and current volume", () => {
    const engine = buildEngine({ settings: buildSettings({ enabled: false, masterVolume: 50 }) });
    render(<SoundsPage engine={engine} />);
    fireEvent.click(screen.getByLabelText("Звуковые реакции"));
    expect(engine.setMaster).toHaveBeenCalledWith(true, 50);
  });

  it("changing the volume slider calls setMaster with the current enabled flag and new volume", () => {
    const engine = buildEngine({ settings: buildSettings({ enabled: true, masterVolume: 50 }) });
    render(<SoundsPage engine={engine} />);
    fireEvent.change(screen.getByRole("slider"), { target: { value: "20" } });
    expect(engine.setMaster).toHaveBeenCalledWith(true, 20);
  });
});
