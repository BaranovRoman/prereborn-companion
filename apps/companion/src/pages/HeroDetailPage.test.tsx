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

function renderPage(overrides: Partial<Parameters<typeof HeroDetailPage>[0]> = {}) {
  return render(
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
      {...overrides}
    />
  );
}

afterEach(() => cleanup());

describe("HeroDetailPage", () => {
  it("renders the hero name, attribute badge, and a back link", () => {
    const onBack = vi.fn();
    renderPage({ onBack });
    expect(screen.getByText("Pudge")).toBeTruthy();
    expect(screen.getByText("Сила")).toBeTruthy();
    fireEvent.click(screen.getByText("← Герои"));
    expect(onBack).toHaveBeenCalled();
  });

  it("toggling favorite calls favorites.toggle with the hero's numeric id", () => {
    const favorites = buildFavorites();
    renderPage({ favorites });
    fireEvent.click(screen.getByLabelText("Добавить в избранное"));
    expect(favorites.toggle).toHaveBeenCalledWith(14);
  });

  // WK-133 - abilities are icon buttons now (no permanent name/status text
  // on screen); the accessible name carries what a tooltip shows visually.
  it("shows the ability strip as icon buttons; unsupported abilities are disabled", () => {
    renderPage();
    const meatHook = screen.getByRole("button", { name: /^Meat Hook\./ }) as HTMLButtonElement;
    expect(meatHook.disabled).toBe(false);
    const rot = screen.getByRole("button", { name: /^Rot\./ }) as HTMLButtonElement;
    expect(rot.disabled).toBe(true);
    expect(rot.className).toContain("hero-ability-icon--unsupported");
  });

  it("the tooltip conveys name, support state, and sound-assignment state", () => {
    renderPage();
    const meatHook = screen.getByRole("button", { name: /^Meat Hook\./ });
    expect(meatHook.getAttribute("aria-label")).toContain("Звук не назначен");
    const rot = screen.getByRole("button", { name: /^Rot\./ });
    expect(rot.getAttribute("aria-label")).toContain("Недоступно");
  });

  it("clicking a supported ability expands ONE inline sound-control panel below the strip (not a modal)", () => {
    const onChooseFile = vi.fn().mockResolvedValue(undefined);
    renderPage({ onChooseFile });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("button", { name: "Выбрать файл" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /^Meat Hook\./ }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getAllByText("Meat Hook").length).toBeGreaterThan(0); // expanded panel's own name label
    fireEvent.click(screen.getByRole("button", { name: "Выбрать файл" }));
    expect(onChooseFile).toHaveBeenCalledWith("pudge_meat_hook", "abilityCast");
  });

  it("selecting a different ability swaps the expanded panel instead of stacking a second one", () => {
    const trackedHero: TrackedHero = {
      ...PUDGE_TRACKED,
      abilities: [
        ...PUDGE_TRACKED.abilities,
        { id: "pudge_dismember", displayName: "Dismember", iconUrl: "x", status: "supported", signal: "cooldown", toggleActiveAlias: null, reason: null },
      ],
    };
    renderPage({ trackedHero });
    fireEvent.click(screen.getByRole("button", { name: /^Meat Hook\./ }));
    expect(screen.getAllByText("Meat Hook")).toHaveLength(2); // tooltip line + expanded panel label
    fireEvent.click(screen.getByRole("button", { name: /^Dismember\./ }));
    expect(screen.getAllByText("Meat Hook")).toHaveLength(1); // only the tooltip line remains
    expect(screen.getAllByText("Dismember")).toHaveLength(2);
  });

  it("clicking the selected ability again collapses the panel", () => {
    renderPage();
    const meatHook = screen.getByRole("button", { name: /^Meat Hook\./ });
    fireEvent.click(meatHook);
    expect(screen.getAllByText("Meat Hook")).toHaveLength(2);
    fireEvent.click(meatHook);
    expect(screen.getAllByText("Meat Hook")).toHaveLength(1);
  });

  it("Escape collapses the expanded panel", () => {
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: /^Meat Hook\./ }));
    expect(screen.getAllByText("Meat Hook")).toHaveLength(2);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.getAllByText("Meat Hook")).toHaveLength(1);
  });

  it("renders a loading placeholder in place of the ability strip while the sound catalog hasn't loaded yet, but the hero name still shows", () => {
    renderPage({ trackedHero: null, settings: null });
    expect(screen.getByText("Pudge")).toBeTruthy();
    expect(screen.getByText(/Загрузка способностей/)).toBeTruthy();
  });

  // WK-133 §13 - subtle inline line, not the old detached full-width banner.
  it("shows a compact hint when custom sounds are globally disabled, and the ability strip stays usable", () => {
    renderPage({ settings: { ...SETTINGS, enabled: false } });
    expect(screen.getByText("Звуковые реакции выключены")).toBeTruthy();
    const meatHook = screen.getByRole("button", { name: /^Meat Hook\./ }) as HTMLButtonElement;
    expect(meatHook.disabled).toBe(false);
  });

  it("does not show the disabled hint when custom sounds are enabled", () => {
    renderPage();
    expect(screen.queryByText("Звуковые реакции выключены")).toBeNull();
  });

  // WK-132 §17/§20 - a preview started on this page must not keep playing
  // once the user navigates away, whether via the back button or by
  // switching to another section entirely (both just unmount this page).
  it("stops any in-flight preview when the page unmounts", () => {
    const stopPreview = vi.fn();
    const { unmount } = renderPage({ stopPreview });
    expect(stopPreview).not.toHaveBeenCalled();
    unmount();
    expect(stopPreview).toHaveBeenCalledTimes(1);
  });

  // WK-132 §24 - real production Techies data from the generated GSI
  // catalog (apps/companion/src-tauri/.../generated_hero_catalog.json):
  // Blast Off (techies_suicide) and 4 other abilities are supported,
  // M.A.D. is unsupported (no cast moment), Minefield Sign and Detonate
  // M.A.D. are experimental. This must keep rendering correctly - this
  // hero specifically motivated the tri-state model.
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

  it("Techies: all 7 abilities render as icons with the correct tri-state (5 supported, 1 unsupported, 2 experimental)", () => {
    renderPage({ heroId: 105, trackedHero: TECHIES_TRACKED });
    for (const ability of TECHIES_TRACKED.abilities) {
      expect(screen.getByText(ability.displayName)).toBeTruthy();
    }
    const mad = screen.getByRole("button", { name: /^M\.A\.D\.\./ }) as HTMLButtonElement;
    expect(mad.disabled).toBe(true);
    expect(mad.className).toContain("hero-ability-icon--unsupported");

    const blastOff = screen.getByRole("button", { name: /^Blast Off!\./ }) as HTMLButtonElement;
    expect(blastOff.disabled).toBe(false);
    expect(blastOff.className).toContain("hero-ability-icon--supported");

    for (const name of [/^Minefield Sign\./, /^Detonate M\.A\.D\.\./]) {
      const el = screen.getByRole("button", { name }) as HTMLButtonElement;
      expect(el.disabled).toBe(false);
      expect(el.className).toContain("hero-ability-icon--experimental");
    }
  });
});
