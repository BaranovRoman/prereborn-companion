import { useEffect, useMemo, useRef, useState } from "react";
import { SectionHeader } from "../components/ui";
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

// Auto-clears an idle typed query, mirroring the same keyboard hero search
// UX apps/web's queue favorite-heroes picker already shipped
// (queue-widgets-panel.tsx) - transient by design, not a persistent filter
// the user has to remember to clear.
const QUERY_IDLE_CLEAR_MS = 3_000;

// WK-121/WK-122 - "Герои", a full primary-nav section, not a modal and not
// the same code as Sounds → Heroes (that grid stays put, see
// HeroesGrid.tsx - both now read from the one consolidated heroCatalog.ts
// instead of two). Favorites render as a compact strip in the header's
// actions slot (top-right, alongside the title - modern Dota's "БАНЫ"
// placement, not a giant full-width block) and simply don't render at all
// when there are no favorites.
//
// WK-122 §8 - no permanent SearchInput: the user just starts typing while
// this screen is open (window keydown, same RU/EN/alias-aware
// `searchHeroes` Sounds → Heroes already used), a transient indicator shows
// the typed query, Backspace edits it, Escape or 3s of inactivity clears it
// - ported from the same UX apps/web's favorite-heroes picker already
// shipped (queue-widgets-panel.tsx's heroQuery/heroSearchOverlay), adapted
// to filter the grid (this screen's own established behavior) rather than
// dim/highlight tiles in place.
export function HeroesPage({ favorites, soundSettings, trackedHeroes, onSelectHero }: Props) {
  const [query, setQuery] = useState("");
  const idleTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    window.clearTimeout(idleTimer.current);
    if (!query) return;
    idleTimer.current = window.setTimeout(() => setQuery(""), QUERY_IDLE_CLEAR_MS);
    return () => window.clearTimeout(idleTimer.current);
  }, [query]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === "Escape") {
        if (query) {
          event.preventDefault();
          setQuery("");
        }
        return;
      }
      if (event.key === "Backspace") {
        if (!query) return;
        event.preventDefault();
        setQuery((value) => value.slice(0, -1));
        return;
      }
      if (/^\p{L}$/u.test(event.key)) {
        event.preventDefault();
        setQuery((value) => `${value}${event.key}`.slice(0, 32));
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  const filtered = useMemo(() => searchHeroes(query), [query]);
  const favoriteHeroes = useMemo(
    () => favorites.heroIds.map((id) => DOTA_HEROES.find((h) => h.id === id)).filter((h): h is HeroCatalogEntry => !!h),
    [favorites.heroIds]
  );

  const grouped = useMemo(() => {
    const groups = new Map<DotaHeroAttribute, HeroCatalogEntry[]>(ATTRIBUTES.map((a) => [a.id, []]));
    for (const hero of filtered) groups.get(hero.attribute)?.push(hero);
    for (const heroes of groups.values()) {
      heroes.sort((a, b) => a.localizedName.localeCompare(b.localizedName, "ru"));
    }
    return groups;
  }, [filtered]);

  return (
    <div className="heroes-page">
      <SectionHeader
        eyebrow="Главная → Герои"
        title="Герои"
        description="Все герои Dota 2 — начните печатать для поиска, способности и звуки назначаются прямо здесь."
        actions={
          favoriteHeroes.length > 0 ? (
            <section className="hero-favorites-strip" aria-label="Избранные герои">
              <h3 className="hero-favorites-strip__title">★ Избранные</h3>
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
                  </button>
                ))}
              </div>
            </section>
          ) : undefined
        }
      />

      {query && (
        <div className="hero-search-indicator" aria-live="polite">
          {query.toLocaleUpperCase()}
        </div>
      )}

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
