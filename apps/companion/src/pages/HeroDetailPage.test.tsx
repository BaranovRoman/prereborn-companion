// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// WK-140 - HeroDetailPage now fetches local hero stats (via
// useHeroLocalStats -> getHeroLocalStats -> Tauri invoke), which isn't
// available under jsdom; mocked the same way DesignPage.test.tsx mocks this
// module. Defaults to a clean "no local history" shape so tests that don't
// care about the stats panel don't need their own override.
// WK-133 - HeroOpenDotaPanel similarly fetches via getHeroOpenDotaStats;
// defaults to "steam_not_connected" (the common no-setup state) so tests
// that don't care about the OpenDota panel don't need their own override.
vi.mock("../services/dotaCompanionApi", () => ({
  getHeroLocalStats: vi.fn().mockResolvedValue({
    matches: 0, wins: 0, losses: 0, avgKills: null, avgDeaths: null, avgAssists: null, recentResults: [],
  }),
  getHeroOpenDotaStats: vi.fn().mockResolvedValue({ status: "steam_not_connected" }),
}));

// eslint-disable-next-line import/order
import { getHeroLocalStats, getHeroOpenDotaStats } from "../services/dotaCompanionApi";
// eslint-disable-next-line import/order
import { HeroDetailPage } from "./HeroDetailPage";
// eslint-disable-next-line import/order
import type { GameSoundSettings, TrackedHero } from "../services/dotaCompanionApi";
// eslint-disable-next-line import/order
import type { useFavoriteHeroes } from "../hooks/useFavoriteHeroes";

const mockedGetHeroLocalStats = vi.mocked(getHeroLocalStats);
const mockedGetHeroOpenDotaStats = vi.mocked(getHeroOpenDotaStats);

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
      onOpenIntegrations={vi.fn()}
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

  // WK-134 §3 - never the browser's native broken-image glyph.
  it("falls back to a quiet neutral placeholder when an ability icon image fails to load, without touching the tri-state class", () => {
    renderPage();
    const meatHook = screen.getByRole("button", { name: /^Meat Hook\./ });
    const img = meatHook.querySelector("img") as HTMLImageElement;
    expect(img).toBeTruthy();
    expect(meatHook.querySelector(".hero-ability-icon__img-fallback")).toBeNull();
    fireEvent.error(img);
    expect(meatHook.querySelector("img")).toBeNull();
    expect(meatHook.querySelector(".hero-ability-icon__img-fallback")).toBeTruthy();
    expect(meatHook.className).toContain("hero-ability-icon--supported");
  });

  // WK-134 §2 - viewport-edge collision: an ability near the left edge
  // opens its tooltip rightward (data-tooltip-align="start"), near the
  // right edge opens it leftward ("end"), otherwise no override (centered).
  it("flips the tooltip alignment near the left/right viewport edges on hover", () => {
    const trackedHero: TrackedHero = {
      ...PUDGE_TRACKED,
      abilities: [
        ...PUDGE_TRACKED.abilities,
        { id: "pudge_dismember", displayName: "Dismember", iconUrl: "x", status: "supported", signal: "cooldown", toggleActiveAlias: null, reason: null },
      ],
    };
    renderPage({ trackedHero });
    const original = window.innerWidth;
    Object.defineProperty(window, "innerWidth", { value: 800, configurable: true });

    const firstIcon = screen.getByRole("button", { name: /^Meat Hook\./ });
    vi.spyOn(firstIcon, "getBoundingClientRect").mockReturnValue({ left: 10, right: 66 } as DOMRect);
    fireEvent.mouseEnter(firstIcon);
    expect(firstIcon.dataset.tooltipAlign).toBe("start");

    const lastIcon = screen.getByRole("button", { name: /^Dismember\./ });
    vi.spyOn(lastIcon, "getBoundingClientRect").mockReturnValue({ left: 734, right: 790 } as DOMRect);
    fireEvent.mouseEnter(lastIcon);
    expect(lastIcon.dataset.tooltipAlign).toBe("end");

    const middleIcon = screen.getByRole("button", { name: /^Rot\./ });
    vi.spyOn(middleIcon, "getBoundingClientRect").mockReturnValue({ left: 400, right: 456 } as DOMRect);
    fireEvent.mouseEnter(middleIcon);
    expect(middleIcon.dataset.tooltipAlign).toBeUndefined();

    Object.defineProperty(window, "innerWidth", { value: original, configurable: true });
  });

  // WK-140 - RIGHT zone: local statistics sourced from getHeroLocalStats.
  describe("local statistics", () => {
    it("shows a quiet empty state for a hero with no local match history", async () => {
      renderPage({ heroId: 105 });
      expect(await screen.findByText("Пока нет матчей в локальной истории")).toBeTruthy();
      expect(screen.queryByText(/матчи/i)).toBeNull();
    });

    it("renders matches/wins/losses/winrate computed from the local aggregate", async () => {
      mockedGetHeroLocalStats.mockResolvedValueOnce({
        matches: 24, wins: 15, losses: 9, avgKills: null, avgDeaths: null, avgAssists: null, recentResults: [],
      });
      renderPage({ heroId: 105 });
      expect(await screen.findByText("24")).toBeTruthy();
      expect(screen.getByText("15")).toBeTruthy();
      expect(screen.getByText("9")).toBeTruthy();
      expect(screen.getByText("62.5%")).toBeTruthy();
    });

    it("does not fabricate a winrate for an all-abandon history", async () => {
      mockedGetHeroLocalStats.mockResolvedValueOnce({
        matches: 3, wins: 0, losses: 0, avgKills: null, avgDeaths: null, avgAssists: null, recentResults: ["abandon", "abandon", "abandon"],
      });
      renderPage({ heroId: 105 });
      expect(await screen.findByText("3")).toBeTruthy();
      expect(screen.getByText("—")).toBeTruthy();
    });

    it("shows average K/D/A only when the backend provides it", async () => {
      mockedGetHeroLocalStats.mockResolvedValueOnce({
        matches: 2, wins: 1, losses: 1, avgKills: 3, avgDeaths: 4, avgAssists: 4, recentResults: ["loss", "win"],
      });
      renderPage({ heroId: 105 });
      expect(await screen.findByText("3.0 / 4.0 / 4.0")).toBeTruthy();
    });

    it("labels statistics as Companion's local history, not lifetime stats", async () => {
      mockedGetHeroLocalStats.mockResolvedValueOnce({
        matches: 1, wins: 1, losses: 0, avgKills: null, avgDeaths: null, avgAssists: null, recentResults: ["win"],
      });
      renderPage({ heroId: 105 });
      expect(await screen.findByText("Локальная история Companion")).toBeTruthy();
    });
  });

  // WK-133 - RIGHT zone addendum: OpenDota's external per-hero statistics,
  // separate from the local-history block above (never merged - see the
  // caption assertions here vs. "Локальная история Companion" above).
  describe("OpenDota statistics", () => {
    it("prompts to open Интеграции when Steam isn't connected", async () => {
      const onOpenIntegrations = vi.fn();
      renderPage({ heroId: 105, onOpenIntegrations });
      expect(await screen.findByText("Steam не привязан")).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Открыть интеграции" }));
      expect(onOpenIntegrations).toHaveBeenCalledTimes(1);
    });

    it("renders games/wins/losses/winrate as a source clearly separate from local history, under the OPENDOTA heading only", async () => {
      mockedGetHeroOpenDotaStats.mockResolvedValueOnce({
        status: "ok", source: "opendota", heroId: 105, games: 40, wins: 25, losses: 15, winRate: 62.5, fetchedAt: new Date().toISOString(),
      });
      renderPage({ heroId: 105 });
      expect(await screen.findByText("40")).toBeTruthy();
      expect(screen.getByText("25")).toBeTruthy();
      expect(screen.getByText("15")).toBeTruthy();
      expect(screen.getByText("62.5%")).toBeTruthy();
      // WK-133 visual review - the OPENDOTA heading already communicates the
      // source; the redundant caption line was removed.
      expect(screen.queryByText(/Внешние данные OpenDota/)).toBeNull();
    });

    it("shows an explicit empty state when OpenDota has no data for this hero", async () => {
      mockedGetHeroOpenDotaStats.mockResolvedValueOnce({ status: "no_data" });
      renderPage({ heroId: 105 });
      expect(await screen.findByText("Нет данных OpenDota по этому герою.")).toBeTruthy();
    });

    it("shows a restrained unavailable state on provider failure, without affecting local stats", async () => {
      mockedGetHeroLocalStats.mockResolvedValueOnce({
        matches: 5, wins: 3, losses: 2, avgKills: null, avgDeaths: null, avgAssists: null, recentResults: [],
      });
      mockedGetHeroOpenDotaStats.mockResolvedValueOnce({ status: "unavailable" });
      renderPage({ heroId: 105 });
      expect(await screen.findByText("OpenDota сейчас недоступна.")).toBeTruthy();
      expect(screen.getByText("5")).toBeTruthy(); // local matches count, unaffected
    });

    it("shows a rate-limited state distinctly from a generic unavailable state", async () => {
      mockedGetHeroOpenDotaStats.mockResolvedValueOnce({ status: "rate_limited" });
      renderPage({ heroId: 105 });
      expect(await screen.findByText("OpenDota временно ограничивает запросы.")).toBeTruthy();
    });

    it("switching heroes refetches OpenDota stats for the new hero", async () => {
      mockedGetHeroOpenDotaStats.mockResolvedValueOnce({
        status: "ok", source: "opendota", heroId: 105, games: 1, wins: 1, losses: 0, winRate: 100, fetchedAt: new Date().toISOString(),
      });
      const { rerender } = renderPage({ heroId: 105 });
      await screen.findByText("100.0%");
      expect(mockedGetHeroOpenDotaStats).toHaveBeenCalledWith(105);

      mockedGetHeroOpenDotaStats.mockResolvedValueOnce({ status: "no_data" });
      rerender(
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
          onOpenIntegrations={vi.fn()}
        />
      );
      expect(mockedGetHeroOpenDotaStats).toHaveBeenCalledWith(14);
    });
  });
});
