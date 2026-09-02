// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HeroDetailPage } from "./HeroDetailPage";
import type { GameSoundSettings, TrackedHero } from "../services/dotaCompanionApi";
import type { useFavoriteHeroes } from "../hooks/useFavoriteHeroes";

function buildFavorites(overrides: Partial<ReturnType<typeof useFavoriteHeroes>> = {}): ReturnType<typeof useFavoriteHeroes> {
  return {
    heroIds: [],
    loading: false,
    error: null,
    busyId: null,
    toggle: vi.fn().mockResolvedValue(undefined),
    maxFavorites: 3,
    refresh: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

const PUDGE_TRACKED: TrackedHero = {
  id: "npc_dota_hero_pudge",
  displayName: "Pudge",
  iconUrl: "https://example.com/pudge.png",
  abilities: [
    { id: "pudge_meat_hook", displayName: "Meat Hook", iconUrl: "x", status: "supported", signal: "cooldown", toggleActiveAlias: null, reason: null },
    { id: "pudge_rot", displayName: "Rot", iconUrl: "x", status: "unsupported", signal: null, toggleActiveAlias: null, reason: "Тоггл-способность без кулдауна." },
  ],
};

const SETTINGS: GameSoundSettings = {
  schemaVersion: 1,
  enabled: true,
  masterVolume: 50,
  bindings: [],
  assets: [],
};

afterEach(() => cleanup());

describe("HeroDetailPage", () => {
  it("renders the hero name, attribute badge, and a back link", () => {
    const onBack = vi.fn();
    render(
      <HeroDetailPage
        heroId={14}
        favorites={buildFavorites()}
        trackedHero={PUDGE_TRACKED}
        settings={SETTINGS}
        onBack={onBack}
        onChooseFile={vi.fn()}
        onPreview={vi.fn()}
        onRemove={vi.fn()}
        stopPreview={vi.fn()}
      />
    );
    expect(screen.getByText("Pudge")).toBeTruthy();
    expect(screen.getByText("Сила")).toBeTruthy();
    fireEvent.click(screen.getByText("← Герои"));
    expect(onBack).toHaveBeenCalled();
  });

  it("toggling favorite calls favorites.toggle with the hero's numeric id", () => {
    const favorites = buildFavorites();
    render(
      <HeroDetailPage
        heroId={14}
        favorites={favorites}
        trackedHero={PUDGE_TRACKED}
        settings={SETTINGS}
        onBack={vi.fn()}
        onChooseFile={vi.fn()}
        onPreview={vi.fn()}
        onRemove={vi.fn()}
        stopPreview={vi.fn()}
      />
    );
    fireEvent.click(screen.getByLabelText("Добавить в избранное"));
    expect(favorites.toggle).toHaveBeenCalledWith(14);
  });

  it("shows the ability bar; unsupported abilities are disabled", () => {
    render(
      <HeroDetailPage
        heroId={14}
        favorites={buildFavorites()}
        trackedHero={PUDGE_TRACKED}
        settings={SETTINGS}
        onBack={vi.fn()}
        onChooseFile={vi.fn()}
        onPreview={vi.fn()}
        onRemove={vi.fn()}
        stopPreview={vi.fn()}
      />
    );
    expect(screen.getByText("Meat Hook")).toBeTruthy();
    const rot = screen.getByTitle(/Rot:/) as HTMLButtonElement;
    expect(rot.disabled).toBe(true);
  });

  it("clicking a supported ability opens the inline sound-binding panel (not a modal)", () => {
    const onChooseFile = vi.fn().mockResolvedValue(undefined);
    render(
      <HeroDetailPage
        heroId={14}
        favorites={buildFavorites()}
        trackedHero={PUDGE_TRACKED}
        settings={SETTINGS}
        onBack={vi.fn()}
        onChooseFile={onChooseFile}
        onPreview={vi.fn()}
        onRemove={vi.fn()}
        stopPreview={vi.fn()}
      />
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByTitle("Meat Hook"));
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Выбрать файл" }));
    expect(onChooseFile).toHaveBeenCalledWith("pudge_meat_hook", "abilityCast");
  });

  it("renders a loading state while the sound catalog hasn't loaded yet", () => {
    render(
      <HeroDetailPage
        heroId={14}
        favorites={buildFavorites()}
        trackedHero={null}
        settings={null}
        onBack={vi.fn()}
        onChooseFile={vi.fn()}
        onPreview={vi.fn()}
        onRemove={vi.fn()}
        stopPreview={vi.fn()}
      />
    );
    expect(screen.getByText(/Загрузка каталога/)).toBeTruthy();
  });

  // WK-132 §27 - globally disabled custom sounds must not block the page;
  // the hint is informational only.
  it("shows a non-blocking hint when custom sounds are globally disabled, and stays usable", () => {
    render(
      <HeroDetailPage
        heroId={14}
        favorites={buildFavorites()}
        trackedHero={PUDGE_TRACKED}
        settings={{ ...SETTINGS, enabled: false }}
        onBack={vi.fn()}
        onChooseFile={vi.fn()}
        onPreview={vi.fn()}
        onRemove={vi.fn()}
        stopPreview={vi.fn()}
      />
    );
    expect(screen.getByText(/выключены глобально/)).toBeTruthy();
    const meatHook = screen.getByTitle("Meat Hook") as HTMLButtonElement;
    expect(meatHook.disabled).toBe(false);
  });

  it("does not show the disabled hint when custom sounds are enabled", () => {
    render(
      <HeroDetailPage
        heroId={14}
        favorites={buildFavorites()}
        trackedHero={PUDGE_TRACKED}
        settings={SETTINGS}
        onBack={vi.fn()}
        onChooseFile={vi.fn()}
        onPreview={vi.fn()}
        onRemove={vi.fn()}
        stopPreview={vi.fn()}
      />
    );
    expect(screen.queryByText(/выключены глобально/)).toBeNull();
  });

  // WK-132 §17/§20 - a preview started on this page must not keep playing
  // once the user navigates away, whether via the back button or by
  // switching to another section entirely (both just unmount this page).
  it("stops any in-flight preview when the page unmounts", () => {
    const stopPreview = vi.fn();
    const { unmount } = render(
      <HeroDetailPage
        heroId={14}
        favorites={buildFavorites()}
        trackedHero={PUDGE_TRACKED}
        settings={SETTINGS}
        onBack={vi.fn()}
        onChooseFile={vi.fn()}
        onPreview={vi.fn()}
        onRemove={vi.fn()}
        stopPreview={stopPreview}
      />
    );
    expect(stopPreview).not.toHaveBeenCalled();
    unmount();
    expect(stopPreview).toHaveBeenCalledTimes(1);
  });

  // WK-132 §24 - real production Techies data from the generated GSI
  // catalog (apps/companion/src-tauri/.../generated_hero_catalog.json):
  // Blast Off (techies_suicide) and 4 other abilities are supported,
  // M.A.D. is unsupported (no cast moment), Minefield Sign and Detonate
  // M.A.D. are experimental. This must keep rendering correctly - this
  // hero specifically motivated the tri-state model and the dense 2-column
  // layout threshold.
  const TECHIES_TRACKED: TrackedHero = {
    id: "npc_dota_hero_techies",
    displayName: "Techies",
    iconUrl: "https://example.com/techies.png",
    abilities: [
      { id: "techies_sticky_bomb", displayName: "Sticky Bomb", iconUrl: "x", status: "supported", signal: "cooldown", toggleActiveAlias: null, reason: null },
      { id: "techies_reactive_tazer", displayName: "Reactive Tazer", iconUrl: "x", status: "supported", signal: "toggleActivateRename", toggleActiveAlias: "techies_reactive_tazer_stop", reason: null },
      { id: "techies_suicide", displayName: "Blast Off!", iconUrl: "x", status: "supported", signal: "cooldown", toggleActiveAlias: null, reason: null },
      { id: "techies_mutually_assured_destruction", displayName: "M.A.D.", iconUrl: "x", status: "unsupported", signal: null, toggleActiveAlias: null, reason: "Пассивная способность." },
      { id: "techies_minefield_sign", displayName: "Minefield Sign", iconUrl: "x", status: "experimental", signal: "cooldown", toggleActiveAlias: null, reason: "GSI-поведение не подтверждено." },
      { id: "techies_land_mines", displayName: "Proximity Mines", iconUrl: "x", status: "supported", signal: "charges", toggleActiveAlias: null, reason: null },
      { id: "techies_focused_detonate", displayName: "Detonate M.A.D.", iconUrl: "x", status: "experimental", signal: "cooldown", toggleActiveAlias: null, reason: "GSI-поведение не подтверждено." },
    ],
  };

  it("Techies: all 7 abilities render with the correct tri-state (5 supported, 1 unsupported, 2 experimental)", () => {
    render(
      <HeroDetailPage
        heroId={105}
        favorites={buildFavorites()}
        trackedHero={TECHIES_TRACKED}
        settings={SETTINGS}
        onBack={vi.fn()}
        onChooseFile={vi.fn()}
        onPreview={vi.fn()}
        onRemove={vi.fn()}
        stopPreview={vi.fn()}
      />
    );
    for (const ability of TECHIES_TRACKED.abilities) {
      expect(screen.getByText(ability.displayName)).toBeTruthy();
    }
    const madRow = screen.getByTitle(/M\.A\.D\.:/) as HTMLButtonElement;
    expect(madRow.disabled).toBe(true);
    const blastOff = screen.getByTitle("Blast Off!") as HTMLButtonElement;
    expect(blastOff.disabled).toBe(false);
    const experimentalRows = ["Minefield Sign", "Detonate M.A.D."].map(
      (name) => screen.getByTitle(new RegExp(`${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\(экспериментально\\)`))
    );
    for (const row of experimentalRows) {
      expect((row as HTMLButtonElement).disabled).toBe(false);
    }
  });
});
