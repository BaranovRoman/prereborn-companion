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
      />
    );
    expect(screen.getByText(/Загрузка каталога/)).toBeTruthy();
  });
});
