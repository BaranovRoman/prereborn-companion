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
// shipped (queue-widgets-panel.tsx's heroQuery/heroSearchOverlay).
//
// WK-132 (Heroes v2 audit) - WK-122 originally had this filter the grid
// (unmatched heroes removed from the DOM, columns reflowing/disappearing).
// Tracing apps/web's queue-widgets-panel.tsx git history further back shows
// that filtering was actually web's ORIGINAL behavior, deliberately
// replaced by a later commit ("keep heroes visible during search") once it
// was found that heroes vanishing/reflowing while typing was bad UX - the
// SETTLED web behavior dims unmatched tiles in place instead and never
// unmounts anything. This file now matches that settled behavior: the full
// grid always renders, only opacity/filter/border toggle per tile.
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

  const matchedIds = useMemo(() => new Set(searchHeroes(query).map((h) => h.id)), [query]);
  const favoriteHeroes = useMemo(
    () => favorites.heroIds.map((id) => DOTA_HEROES.find((h) => h.id === id)).filter((h): h is HeroCatalogEntry => !!h),
    [favorites.heroIds]
  );

  // WK-132 - always grouped from the full roster (not a filtered subset) so
  // the grid never reflows/loses columns while searching; see doc comment
  // above `matchedIds` drives per-tile dim/highlight instead.
  const grouped = useMemo(() => {
    const groups = new Map<DotaHeroAttribute, HeroCatalogEntry[]>(ATTRIBUTES.map((a) => [a.id, []]));
    for (const hero of DOTA_HEROES) groups.get(hero.attribute)?.push(hero);
    for (const heroes of groups.values()) {
      heroes.sort((a, b) => a.localizedName.localeCompare(b.localizedName, "ru"));
    }
    return groups;
  }, []);

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

      <div className="hero-roster">
        {/* WK-141 - the active query is a temporary Reaver overlay ON the
            roster (absolutely positioned, pointer-events: none), not a
            form field: idle vs. active-search roster geometry stays
            byte-for-byte identical since this never occupies flow space -
            see this task's own "overlay, not reflow" requirement. */}
        {query && (
          <div className="hero-search-overlay" aria-live="polite">
            <div className="hero-search-overlay__inner">
              <span className="hero-search-overlay__query">{query.toLocaleUpperCase()}</span>
              {matchedIds.size === 0 && <span className="hero-search-overlay__hint">Герой не найден</span>}
            </div>
          </div>
        )}

        <div className="attribute-grid">
          {ATTRIBUTES.map((attribute) => {
            const attributeHeroes = grouped.get(attribute.id) ?? [];
            return (
              <section key={attribute.id} className="attribute-column">
                <h3><img src={attribute.iconUrl} alt="" aria-hidden="true" />{attribute.label}</h3>
                <div className="hero-portrait-grid" role="list" data-searching={query ? "true" : "false"}>
                  {attributeHeroes.map((hero) => {
                    const count = configuredCount(hero, trackedHeroes, soundSettings);
                    const isFavorite = favorites.heroIds.includes(hero.id);
                    const isMatch = !query || matchedIds.has(hero.id);
                    return (
                      <button
                        key={hero.id}
                        type="button"
                        role="listitem"
                        className={`hero-portrait-tile ${count > 0 ? "hero-portrait-tile--configured" : ""}`}
                        data-search-match={isMatch ? "true" : "false"}
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
      </div>
      {favorites.error && <p className="app__error">Ошибка: {favorites.error}</p>}
    </div>
  );
}
