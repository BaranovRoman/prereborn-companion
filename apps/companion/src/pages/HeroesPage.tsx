import { useMemo, useState } from "react";
import { SectionHeader, SearchInput } from "../components/ui";
import type { useFavoriteHeroes } from "../hooks/useFavoriteHeroes";
import type { GameSoundSettings, TrackedHero } from "../services/dotaCompanionApi";
import { DOTA_HEROES, type DotaHeroAttribute, type HeroCatalogEntry, searchHeroes } from "../services/heroCatalog";

interface Props {
  favorites: ReturnType<typeof useFavoriteHeroes>;
  soundSettings: GameSoundSettings | null;
  trackedHeroes: TrackedHero[];
  onSelectHero: (heroId: number) => void;
}

const ATTRIBUTES: Array<{ id: DotaHeroAttribute; label: string; iconUrl: string }> = [
  { id: "strength", label: "Сила", iconUrl: "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/icons/hero_strength.png" },
  { id: "agility", label: "Ловкость", iconUrl: "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/icons/hero_agility.png" },
  { id: "intelligence", label: "Интеллект", iconUrl: "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/icons/hero_intelligence.png" },
  { id: "universal", label: "Универсальные", iconUrl: "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/icons/hero_universal.png" },
];

function configuredCount(hero: HeroCatalogEntry, trackedHeroes: TrackedHero[], settings: GameSoundSettings | null): number {
  if (!settings) return 0;
  const tracked = trackedHeroes.find((t) => t.id === `npc_dota_hero_${hero.name}`);
  if (!tracked) return 0;
  return tracked.abilities.filter((ability) =>
    settings.bindings.some((b) => b.eventId === ability.id && b.kind === "abilityCast")
  ).length;
}

// WK-121 - "Герои", a full primary-nav section (§6 of the task), not a
// modal and not the same code as Sounds → Heroes (that grid stays put,
// see HeroesGrid.tsx - both now read from the one consolidated
// heroCatalog.ts instead of two). Favorites render as a compact horizontal
// strip above the grid, visually close to modern Dota's "BAN HEROES" strip
// (small portrait cards, one row, not giant tiles) - and simply doesn't
// render at all when there are no favorites, per the task's explicit "не
// занимать большое пустое место" instruction.
export function HeroesPage({ favorites, soundSettings, trackedHeroes, onSelectHero }: Props) {
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => searchHeroes(query), [query]);
  const favoriteHeroes = useMemo(
    () => favorites.heroIds.map((id) => DOTA_HEROES.find((h) => h.id === id)).filter((h): h is HeroCatalogEntry => !!h),
    [favorites.heroIds]
  );

  const grouped = useMemo(() => {
    const groups = new Map<DotaHeroAttribute, HeroCatalogEntry[]>(ATTRIBUTES.map((a) => [a.id, []]));
    for (const hero of filtered) groups.get(hero.attribute)?.push(hero);
    return groups;
  }, [filtered]);

  return (
    <div className="heroes-page">
      <SectionHeader
        eyebrow="Главная → Герои"
        title="Герои"
        description="Все герои Dota 2 — избранное, способности и звуки назначаются прямо здесь."
      />

      {favoriteHeroes.length > 0 && (
        <section className="hero-favorites-strip" aria-label="Избранные герои">
          <h3 className="hero-favorites-strip__title">Избранное</h3>
          <div className="hero-favorites-strip__row" role="list">
            {favoriteHeroes.map((hero) => (
              <button
                key={hero.id}
                type="button"
                role="listitem"
                className="hero-favorites-strip__card"
                title={hero.localizedName}
                onClick={() => onSelectHero(hero.id)}
              >
                <img src={hero.iconUrl} alt="" loading="lazy" />
                <span>{hero.localizedName}</span>
              </button>
            ))}
          </div>
        </section>
      )}

      <SearchInput
        placeholder="Поиск героя… (RU/EN)"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onClear={() => setQuery("")}
        aria-label="Поиск героя"
      />

      {filtered.length === 0 ? (
        <p className="heroes-grid__empty">Герой не найден.</p>
      ) : (
        <div className="attribute-grid">
          {ATTRIBUTES.map((attribute) => {
            const attributeHeroes = grouped.get(attribute.id) ?? [];
            if (attributeHeroes.length === 0) return null;
            return (
              <section key={attribute.id} className="attribute-column">
                <h3><img src={attribute.iconUrl} alt="" aria-hidden="true" />{attribute.label}</h3>
                <div className="hero-portrait-grid" role="list">
                  {attributeHeroes.map((hero) => {
                    const count = configuredCount(hero, trackedHeroes, soundSettings);
                    const isFavorite = favorites.heroIds.includes(hero.id);
                    return (
                      <button
                        key={hero.id}
                        type="button"
                        role="listitem"
                        className={`hero-portrait-tile ${count > 0 ? "hero-portrait-tile--configured" : ""}`}
                        title={hero.localizedName}
                        onClick={() => onSelectHero(hero.id)}
                      >
                        <img className="hero-portrait-tile__image" src={hero.iconUrl} alt="" loading="lazy" />
                        <span
                          className={`hero-portrait-tile__favorite ${isFavorite ? "is-active" : ""}`}
                          role="button"
                          tabIndex={-1}
                          aria-label={isFavorite ? "Убрать из избранного" : "Добавить в избранное"}
                          onClick={(event) => {
                            event.stopPropagation();
                            void favorites.toggle(hero.id);
                          }}
                        >
                          ★
                        </span>
                        <span className="hero-portrait-tile__name">{hero.localizedName}</span>
                        {count > 0 && (
                          <b className="hero-portrait-tile__badge" aria-hidden="true">{count}</b>
                        )}
                      </button>
                    );
                  })}
                </div>
              </section>
            );
          })}
        </div>
      )}
      {favorites.error && <p className="app__error">Ошибка: {favorites.error}</p>}
    </div>
  );
}
