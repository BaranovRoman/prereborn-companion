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

  // WK-132 - matches apps/web's settled search behavior: unmatched heroes
  // stay mounted (dimmed via data-search-match="false"), not removed from
  // the DOM - the grid must never reflow while typing.
  it("typing anywhere dims non-matching tiles in place (RU alias support) without unmounting them", () => {
    render(
      <HeroesPage favorites={buildFavorites()} soundSettings={null} trackedHeroes={[]} onSelectHero={vi.fn()} />
    );
    typeIntoHeroSearch("пудж");
    const pudge = screen.getByTitle("Pudge");
    const antiMage = screen.getByTitle("Anti-Mage");
    expect(pudge.getAttribute("data-search-match")).toBe("true");
    expect(antiMage.getAttribute("data-search-match")).toBe("false");
    expect(screen.getByText("ПУДЖ")).toBeTruthy();
  });

  it("Backspace edits the query and Escape clears it immediately", () => {
    render(
      <HeroesPage favorites={buildFavorites()} soundSettings={null} trackedHeroes={[]} onSelectHero={vi.fn()} />
    );
    typeIntoHeroSearch("pudgex");
    expect(screen.getByTitle("Pudge").getAttribute("data-search-match")).toBe("false"); // "pudgex" matches nothing
    fireEvent.keyDown(window, { key: "Backspace" });
    expect(screen.getByTitle("Pudge").getAttribute("data-search-match")).toBe("true"); // back to "pudge"
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByText("PUDGE")).toBeNull();
    expect(screen.getByTitle("Anti-Mage").getAttribute("data-search-match")).toBe("true"); // full grid, no dimming
  });

  it("shows a 'not found' hint without hiding the grid for a query matching nothing", () => {
    render(
      <HeroesPage favorites={buildFavorites()} soundSettings={null} trackedHeroes={[]} onSelectHero={vi.fn()} />
    );
    typeIntoHeroSearch("zzznotahero");
    expect(screen.getByText(/герой не найден/i)).toBeTruthy();
    // the grid itself stays fully mounted, just entirely dimmed
    expect(screen.getByTitle("Pudge").getAttribute("data-search-match")).toBe("false");
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

  // WK-141 - the active query renders as a large Reaver overlay ON the
  // roster, not the old bordered/backgrounded form-input-like chip.
  it("shows the active query as a Reaver overlay, with no leftover search-bar chrome", () => {
    render(
      <HeroesPage favorites={buildFavorites()} soundSettings={null} trackedHeroes={[]} onSelectHero={vi.fn()} />
    );
    expect(document.querySelector(".hero-search-overlay")).toBeNull();
    expect(document.querySelector(".hero-search-indicator")).toBeNull();

    typeIntoHeroSearch("tec");
    const overlay = document.querySelector(".hero-search-overlay");
    expect(overlay).toBeTruthy();
    expect(overlay?.querySelector(".hero-search-overlay__query")?.textContent).toBe("TEC");
    // no legacy bordered/backgrounded chip left behind
    expect(document.querySelector(".hero-search-indicator")).toBeNull();
  });

  // WK-141 - overlay presentation must not disturb roster geometry: the
  // grid stays the query's sibling, mounted the exact same way whether or
  // not a search is active (no wrapping/reflow container swap).
  it("the search overlay does not reflow the roster grid", () => {
    render(
      <HeroesPage favorites={buildFavorites()} soundSettings={null} trackedHeroes={[]} onSelectHero={vi.fn()} />
    );
    const grid = document.querySelector(".attribute-grid");
    const idleParent = grid?.parentElement;
    typeIntoHeroSearch("tec");
    expect(document.querySelector(".attribute-grid")?.parentElement).toBe(idleParent);
  });

  // WK-144 - Space silently didn't reach the query (the keydown handler's
  // letter regex never matched " "), making multi-word hero names
  // unsearchable by typing. Real catalog entries, per the task's own
  // instruction not to invent hero names for this.
  describe("multi-word search (Space)", () => {
    it("Space participates in the query so a multi-word hero name matches", () => {
      render(
        <HeroesPage favorites={buildFavorites()} soundSettings={null} trackedHeroes={[]} onSelectHero={vi.fn()} />
      );
      typeIntoHeroSearch("outworld destroyer");
      expect(screen.getByText("OUTWORLD DESTROYER")).toBeTruthy();
      expect(screen.getByTitle("Outworld Destroyer").getAttribute("data-search-match")).toBe("true");
      expect(screen.getByTitle("Pudge").getAttribute("data-search-match")).toBe("false");
    });

    it("matches other real multi-word hero names the same way", () => {
      render(
        <HeroesPage favorites={buildFavorites()} soundSettings={null} trackedHeroes={[]} onSelectHero={vi.fn()} />
      );
      typeIntoHeroSearch("queen of pain");
      expect(screen.getByTitle("Queen of Pain").getAttribute("data-search-match")).toBe("true");
      fireEvent.keyDown(window, { key: "Escape" });
      typeIntoHeroSearch("keeper of the light");
      expect(screen.getByTitle("Keeper of the Light").getAttribute("data-search-match")).toBe("true");
    });

    it("ignores a leading space instead of starting the query with one", () => {
      render(
        <HeroesPage favorites={buildFavorites()} soundSettings={null} trackedHeroes={[]} onSelectHero={vi.fn()} />
      );
      fireEvent.keyDown(window, { key: " " });
      // no overlay should have mounted for a query that's still effectively empty
      expect(document.querySelector(".hero-search-overlay")).toBeNull();
      typeIntoHeroSearch("pudge");
      expect(screen.getByText("PUDGE")).toBeTruthy();
    });

    it("collapses repeated spaces instead of breaking the multi-word match", () => {
      render(
        <HeroesPage favorites={buildFavorites()} soundSettings={null} trackedHeroes={[]} onSelectHero={vi.fn()} />
      );
      typeIntoHeroSearch("outworld");
      fireEvent.keyDown(window, { key: " " });
      fireEvent.keyDown(window, { key: " " }); // second consecutive space - must be a no-op
      typeIntoHeroSearch("destroyer");
      expect(screen.getByText("OUTWORLD DESTROYER")).toBeTruthy();
      expect(screen.getByTitle("Outworld Destroyer").getAttribute("data-search-match")).toBe("true");
    });

    it("Backspace removes a trailing space like any other character", () => {
      render(
        <HeroesPage favorites={buildFavorites()} soundSettings={null} trackedHeroes={[]} onSelectHero={vi.fn()} />
      );
      typeIntoHeroSearch("outworld ");
      expect(screen.getByText("OUTWORLD")).toBeTruthy();
      fireEvent.keyDown(window, { key: "Backspace" });
      typeIntoHeroSearch("destroyer");
      // the space was removed, so this would now read "outworlddestroyer" -
      // a real regression this test would catch, not just a smoke check.
      expect(screen.getByTitle("Outworld Destroyer").getAttribute("data-search-match")).toBe("false");
    });

    it("clearing the query after a multi-word search restores the exact idle roster", () => {
      render(
        <HeroesPage favorites={buildFavorites()} soundSettings={null} trackedHeroes={[]} onSelectHero={vi.fn()} />
      );
      typeIntoHeroSearch("outworld destroyer");
      fireEvent.keyDown(window, { key: "Escape" });
      expect(screen.queryByText("OUTWORLD DESTROYER")).toBeNull();
      expect(screen.getByTitle("Pudge").getAttribute("data-search-match")).toBe("true");
      expect(screen.getByTitle("Outworld Destroyer").getAttribute("data-search-match")).toBe("true");
    });

    it("clicking the star toggles favorite while a multi-word query is active (favorites unaffected)", () => {
      const favorites = buildFavorites();
      render(
        <HeroesPage favorites={favorites} soundSettings={null} trackedHeroes={[]} onSelectHero={vi.fn()} />
      );
      typeIntoHeroSearch("outworld destroyer");
      const tile = screen.getByTitle("Outworld Destroyer");
      fireEvent.click(within(tile).getByLabelText("Добавить в избранное"));
      expect(favorites.toggle).toHaveBeenCalledWith(76);
    });
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
