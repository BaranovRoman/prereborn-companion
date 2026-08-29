import { getHeroById } from "../../src/services/heroCatalog";
import type { CurrentGameSnapshot } from "../types";

// WK-121 - "Current Game" widget: hero portrait/name + KDA while GSI
// reports an active hero (Draft/Gameplay). Hero name/icon resolution reuses
// the SAME heroCatalog.ts the rest of Companion (HomePage, Heroes section)
// already uses - no second hero-id mapping in this renderer.
export function CurrentGameWidget({ game }: { game: CurrentGameSnapshot | null }) {
  if (!game?.heroId) return null;
  const hero = getHeroById(game.heroId);

  return (
    <div className="ov-current-game">
      {hero && <img className="ov-current-game__portrait" src={hero.iconUrl} alt="" />}
      <div className="ov-current-game__info">
        <span className="ov-current-game__hero">{hero?.localizedName ?? `Герой #${game.heroId}`}</span>
        {(game.kills !== null || game.deaths !== null || game.assists !== null) && (
          <span className="ov-current-game__kda">
            {game.kills ?? 0} / {game.deaths ?? 0} / {game.assists ?? 0}
          </span>
        )}
      </div>
    </div>
  );
}
