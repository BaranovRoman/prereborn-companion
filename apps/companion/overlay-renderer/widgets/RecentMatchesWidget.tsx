import { getHeroById } from "../../src/services/heroCatalog";
import type { LocalMatchSummary } from "../types";

// WK-128 - closes the parity gap flagged in a production visual review:
// Между матчами/Итоги стрима previously showed only a title + the win/loss
// record badge (SessionWidget) - real match-by-match history
// (session.recentMatches) was already flowing through OverlayStateSnapshot
// (local_runtime::summary, backend-independent) but nothing in this
// renderer displayed it, so those two scenes read as a placeholder next to
// the richer production apps/web overlay's RecentMatches widget. Same data
// source, a simpler visual (a compact row of hero portraits with a win/loss
// border tint + MMR delta) - not a port of apps/web's positionable
// RecentMatches component, which depends on OverlayLayout widget slots this
// renderer's schema doesn't define for a recentMatches widget (see types.ts's
// OverlaySceneWidgets) - adding one would mean extending Оформление's editor
// too, out of scope for this fix. Renders nothing when there's no finalized
// match yet, matching every other widget's "render nothing over rendering a
// placeholder" convention here.
export function RecentMatchesWidget({ matches }: { matches: LocalMatchSummary[] }) {
  const finalized = matches.filter((match) => match.result !== null);
  if (finalized.length === 0) return null;

  return (
    <div className="ov-recent-matches">
      {finalized.map((match) => {
        const hero = getHeroById(match.heroId);
        const delta =
          match.ratingBefore !== null && match.ratingAfter !== null
            ? match.ratingAfter - match.ratingBefore
            : null;
        return (
          <div
            key={match.matchId ?? match.startedAt}
            className={`ov-recent-matches__item ov-recent-matches__item--${match.result}`}
            title={hero?.localizedName}
          >
            {hero && <img className="ov-recent-matches__portrait" src={hero.iconUrl} alt="" />}
            {delta !== null && (
              <span className={`ov-recent-matches__delta ${delta >= 0 ? "is-positive" : "is-negative"}`}>
                {delta >= 0 ? "+" : ""}
                {delta}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}
