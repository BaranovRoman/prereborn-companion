// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
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
    { id: "pudge_meat_hook", displayName: "Meat Hook", iconUrl: "https://example.com/hook.png", status: "supported", signal: "cooldown", toggleActiveAlias: null, reason: null },
    { id: "pudge_rot", displayName: "Rot", iconUrl: "https://example.com/rot.png", status: "unsupported", signal: null, toggleActiveAlias: null, reason: "Тоггл-способность без кулдауна." },
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
  it("shows three visually distinct item states in the catalog", () => {
    render(<SoundsPage engine={buildEngine()} />);
    // §14 - unsupported items stay browsable/clickable (the inspector is
    // what explains they're unsupported), unlike the old grid which
    // disabled them outright - only visually muted via the CSS class.
    const unsupported = screen.getByTitle("Yasha");
    expect(unsupported.className).toContain("sound-tile--unsupported");
    expect((unsupported as HTMLButtonElement).disabled).toBe(false);

    const blink = screen.getByTitle("Blink Dagger");
    expect(blink.className).toContain("sound-tile--supported");
    expect((blink as HTMLButtonElement).disabled).toBe(false);

    const tango = screen.getByTitle("Tango");
    expect(tango.className).toContain("sound-tile--configured");
  });

  it("clicking a supported item selects it in the persistent inspector, not a modal", () => {
    render(<SoundsPage engine={buildEngine()} />);
    fireEvent.click(screen.getByTitle("Blink Dagger"));
    expect(screen.queryByRole("dialog")).toBeNull();
    const inspector = screen.getByLabelText("Информация о предмете");
    expect(within(inspector).getByText("Blink Dagger")).toBeTruthy();
  });

  it("clicking an unsupported item selects it too (still browsable), and the inspector says the event isn't supported yet", () => {
    render(<SoundsPage engine={buildEngine()} />);
    fireEvent.click(screen.getByTitle("Yasha"));
    const inspector = screen.getByLabelText("Информация о предмете");
    expect(within(inspector).getByText("Yasha")).toBeTruthy();
    expect(within(inspector).getByText(/пока не поддерживается/)).toBeTruthy();
    expect(within(inspector).queryByRole("button", { name: "Выбрать файл" })).toBeNull();
  });

  it("the configured item's inspector shows the bound file and lets you remove it", async () => {
    const engine = buildEngine();
    render(<SoundsPage engine={engine} />);
    fireEvent.click(screen.getByTitle("Tango"));
    const inspector = screen.getByLabelText("Информация о предмете");
    expect(within(inspector).getByText("chomp.wav")).toBeTruthy();

    fireEvent.click(within(inspector).getByRole("button", { name: "Удалить звук" }));
    expect(engine.removeBinding).toHaveBeenCalledWith("item_tango");
  });

  it("choosing a file imports and binds it to the event in one atomic step", async () => {
    const engine = buildEngine();
    render(<SoundsPage engine={engine} />);
    fireEvent.click(screen.getByTitle("Blink Dagger"));
    const inspector = screen.getByLabelText("Информация о предмете");

    fireEvent.click(within(inspector).getByRole("button", { name: "Выбрать файл" }));
    await Promise.resolve();
    await Promise.resolve();

    expect(engine.chooseAndBindFile).toHaveBeenCalledWith("item_blink", "itemUsed");
  });

  it("preview is disabled until a sound is bound", () => {
    render(<SoundsPage engine={buildEngine()} />);
    fireEvent.click(screen.getByTitle("Blink Dagger"));
    const inspector = screen.getByLabelText("Информация о предмете");
    expect((within(inspector).getByRole("button", { name: "Прослушать" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("groups items by real shop category, not a flat list", () => {
    render(<SoundsPage engine={buildEngine()} />);
    expect(screen.getByText("Основные")).toBeTruthy();
    // Blink Dagger -> accessories -> Улучшения, per itemCategories.ts.
    expect(screen.getByText("Улучшения")).toBeTruthy();
    expect(screen.getByRole("heading", { level: 4, name: "Аксессуары" })).toBeTruthy();
  });
});

// WK-122 §12 - hero-ability sound assignment moved to the hero's own page
// (HeroDetailPage.tsx); there is no "Герои" tab left in Sounds at all, not
// even as a redirect.
describe("SoundsPage - no Герои tab", () => {
  it("has no Герои tab or hero-ability UI anywhere on this page", () => {
    render(<SoundsPage engine={buildEngine()} />);
    expect(screen.queryByRole("tab", { name: "Герои" })).toBeNull();
    expect(screen.queryByTitle("Pudge")).toBeNull();
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
