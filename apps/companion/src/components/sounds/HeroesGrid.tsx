import { useMemo, useState } from "react";
import type { GameSoundSettings, TrackedHero } from "../../services/dotaCompanionApi";

interface Props {
  heroes: TrackedHero[];
  settings: GameSoundSettings;
  onSelect: (hero: TrackedHero) => void;
}

export function HeroesGrid({ heroes, settings, onSelect }: Props) {
  const [query, setQuery] = useState("");
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return heroes;
    return heroes.filter((hero) => hero.displayName.toLowerCase().includes(q));
  }, [heroes, query]);

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
      <div className="sound-grid" role="list">
        {filtered.map((hero) => {
          const configuredCount = hero.abilities.filter((ability) =>
            settings.bindings.some((b) => b.eventId === ability.id && b.kind === "abilityCast")
          ).length;
          return (
            <button
              key={hero.id}
              type="button"
              role="listitem"
              className={`sound-tile ${configuredCount > 0 ? "sound-tile--configured" : "sound-tile--supported"}`}
              title={hero.displayName}
              onClick={() => onSelect(hero)}
            >
              <img className="sound-tile__icon sound-tile__icon--hero" src={hero.iconUrl} alt="" width={59} height={33} loading="lazy" />
              <span className="sound-tile__label">{hero.displayName}</span>
              {configuredCount > 0 && (
                <span className="sound-tile__badge" aria-hidden="true">{configuredCount}</span>
              )}
            </button>
          );
        })}
        {filtered.length === 0 && <p className="heroes-grid__empty">Герой не найден.</p>}
      </div>
    </div>
  );
}
