// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HeroesPage } from "./HeroesPage";
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
  ],
};

const SETTINGS: GameSoundSettings = {
  schemaVersion: 1,
  enabled: true,
  masterVolume: 50,
  bindings: [{ eventId: "pudge_meat_hook", kind: "abilityCast", assetId: "asset-1" }],
  assets: [{ id: "asset-1", fileName: "a.wav", originalName: "hook.wav", sizeBytes: 1 }],
};

afterEach(() => cleanup());

// WK-122 §8 - there is no permanent search input anymore; typing anywhere
// while the screen is open is what drives the query (a window keydown
// listener, see HeroesPage.tsx). Simulates real typing one character at a
// time, exactly like the keyboard would produce it.
function typeIntoHeroSearch(text: string) {
  for (const key of text) fireEvent.keyDown(window, { key });
}

describe("HeroesPage", () => {
  it("renders the full hero grid grouped by attribute, no favorites strip when empty", () => {
    render(
      <HeroesPage favorites={buildFavorites()} soundSettings={null} trackedHeroes={[]} onSelectHero={vi.fn()} />
    );
    expect(screen.getByTitle("Pudge")).toBeTruthy();
    expect(screen.getByTitle("Anti-Mage")).toBeTruthy();
    expect(screen.queryByLabelText("Избранные герои")).toBeNull();
  });

  it("has no permanent search input", () => {
    render(
      <HeroesPage favorites={buildFavorites()} soundSettings={null} trackedHeroes={[]} onSelectHero={vi.fn()} />
    );
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("typing anywhere filters the grid (RU alias support) and shows a transient indicator", () => {
    render(
      <HeroesPage favorites={buildFavorites()} soundSettings={null} trackedHeroes={[]} onSelectHero={vi.fn()} />
    );
    typeIntoHeroSearch("пудж");
    expect(screen.getByTitle("Pudge")).toBeTruthy();
    expect(screen.queryByTitle("Anti-Mage")).toBeNull();
    expect(screen.getByText("ПУДЖ")).toBeTruthy();
  });

  it("Backspace edits the query and Escape clears it immediately", () => {
    render(
      <HeroesPage favorites={buildFavorites()} soundSettings={null} trackedHeroes={[]} onSelectHero={vi.fn()} />
    );
    typeIntoHeroSearch("pudgex");
    expect(screen.queryByTitle("Pudge")).toBeNull(); // "pudgex" matches nothing
    fireEvent.keyDown(window, { key: "Backspace" });
    expect(screen.getByTitle("Pudge")).toBeTruthy(); // back to "pudge"
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByText("PUDGE")).toBeNull();
    expect(screen.getByTitle("Anti-Mage")).toBeTruthy(); // full grid is back
  });

  it("shows 'not found' for a query matching nothing", () => {
    render(
      <HeroesPage favorites={buildFavorites()} soundSettings={null} trackedHeroes={[]} onSelectHero={vi.fn()} />
    );
    typeIntoHeroSearch("zzznotahero");
    expect(screen.getByText("Герой не найден.")).toBeTruthy();
  });

  it("clicking a hero tile calls onSelectHero with its numeric id", () => {
    const onSelectHero = vi.fn();
    render(
      <HeroesPage favorites={buildFavorites()} soundSettings={null} trackedHeroes={[]} onSelectHero={onSelectHero} />
    );
    fireEvent.click(screen.getByTitle("Pudge"));
    expect(onSelectHero).toHaveBeenCalledWith(14);
  });

  it("clicking the star toggles favorite without navigating to the hero", () => {
    const onSelectHero = vi.fn();
    const favorites = buildFavorites();
    render(
      <HeroesPage favorites={favorites} soundSettings={null} trackedHeroes={[]} onSelectHero={onSelectHero} />
    );
    const pudgeTile = screen.getByTitle("Pudge");
    fireEvent.click(within(pudgeTile).getByLabelText("Добавить в избранное"));
    expect(favorites.toggle).toHaveBeenCalledWith(14);
    expect(onSelectHero).not.toHaveBeenCalled();
  });

  it("renders a compact favorites strip when favorites exist, and it navigates on click", () => {
    const onSelectHero = vi.fn();
    render(
      <HeroesPage
        favorites={buildFavorites({ heroIds: [14] })}
        soundSettings={null}
        trackedHeroes={[]}
        onSelectHero={onSelectHero}
      />
    );
    const strip = screen.getByLabelText("Избранные герои");
    expect(within(strip).getByTitle("Pudge")).toBeTruthy();
    fireEvent.click(within(strip).getByTitle("Pudge"));
    expect(onSelectHero).toHaveBeenCalledWith(14);
  });

  it("shows a configured-count badge for heroes with bound ability sounds", () => {
    render(
      <HeroesPage
        favorites={buildFavorites()}
        soundSettings={SETTINGS}
        trackedHeroes={[PUDGE_TRACKED]}
        onSelectHero={vi.fn()}
      />
    );
    const tile = screen.getByTitle("Pudge");
    expect(tile.className).toContain("hero-portrait-tile--configured");
  });
});
