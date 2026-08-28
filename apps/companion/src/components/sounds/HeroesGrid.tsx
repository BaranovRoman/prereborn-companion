import { useMemo, useState } from "react";
import type { GameSoundSettings, TrackedHero } from "../../services/dotaCompanionApi";
import { getHeroAttribute, type DotaHeroAttribute } from "../../services/heroAttributes";
import { getHeroByInternalName } from "../../services/heroCatalog";

interface Props {
  heroes: TrackedHero[];
  settings: GameSoundSettings;
  onSelect: (hero: TrackedHero) => void;
}

const ATTRIBUTES: Array<{ id: DotaHeroAttribute; label: string; iconUrl: string }> = [
  { id: "strength", label: "Сила", iconUrl: "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/icons/hero_strength.png" },
  { id: "agility", label: "Ловкость", iconUrl: "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/icons/hero_agility.png" },
  { id: "intelligence", label: "Интеллект", iconUrl: "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/icons/hero_intelligence.png" },
  { id: "universal", label: "Универсальные", iconUrl: "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/icons/hero_universal.png" },
];

// WK-116 - "hero grid должен ощущаться как выбор героя в Dota" per the
// task: ported the portrait-tile visual pattern AND the attribute grouping
// from apps/web's existing Favorite Heroes picker
// (apps/web/src/components/pages/stream/settings/queue-widgets-panel.tsx,
// `.heroGrid`/`.heroTile`/`.attributeGrid`/`.attributeColumn` in its
// .module.scss) instead of reusing the generic `.sound-tile` icon-card
// look ItemsGrid.tsx still uses (that grid is for non-hero item sounds,
// kept exactly as it was - only Heroes changes here). Not a literal import
// (Companion is a separate Vite app, no CSS Modules, no shared package -
// see AppAtmosphere.tsx's history for why), but the same recipe: heroes
// split into Strength/Agility/Intelligence/Universal columns, each its own
// compact 4-wide sub-grid of wide portrait tiles with the hero name as a
// bottom text overlay, a dim/desaturated idle state, and a small red-chip
// badge marking heroes that already have a sound bound (the "configured"
// concept the old generic tile badge already had, carried over intact).
// The grouping itself needed hero-attribute data Companion's own catalog
// doesn't carry (TrackedHero/generated_hero_catalog.json has no attribute
// field) - bridged via the small ported heroCatalog.ts/heroAttributes.ts
// (see their own doc comments) rather than touching the Rust catalog for
// a presentation-only grouping.
export function HeroesGrid({ heroes, settings, onSelect }: Props) {
  const [query, setQuery] = useState("");
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return heroes;
    return heroes.filter((hero) => hero.displayName.toLowerCase().includes(q));
  }, [heroes, query]);

  const grouped = useMemo(() => {
    const groups = new Map<DotaHeroAttribute, TrackedHero[]>(ATTRIBUTES.map((a) => [a.id, []]));
    for (const hero of filtered) {
      const internalName = hero.id.replace(/^npc_dota_hero_/, "");
      const catalogEntry = getHeroByInternalName(internalName);
      const attribute = catalogEntry ? getHeroAttribute(catalogEntry.id) : "universal";
      groups.get(attribute)?.push(hero);
    }
    return groups;
  }, [filtered]);

  return (
    <div className="heroes-grid-wrap">
      <input
        className="heroes-grid__search"
        type="search"
        placeholder="Поиск героя…"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
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
                    const configuredCount = hero.abilities.filter((ability) =>
                      settings.bindings.some((b) => b.eventId === ability.id && b.kind === "abilityCast")
                    ).length;
                    const configured = configuredCount > 0;
                    return (
                      <button
                        key={hero.id}
                        type="button"
                        role="listitem"
                        className={`hero-portrait-tile ${configured ? "hero-portrait-tile--configured" : ""}`}
                        title={hero.displayName}
                        onClick={() => onSelect(hero)}
                      >
                        <img className="hero-portrait-tile__image" src={hero.iconUrl} alt="" loading="lazy" />
                        <span className="hero-portrait-tile__name">{hero.displayName}</span>
                        {configured && (
                          <b className="hero-portrait-tile__badge" aria-hidden="true">{configuredCount}</b>
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
    </div>
  );
}
