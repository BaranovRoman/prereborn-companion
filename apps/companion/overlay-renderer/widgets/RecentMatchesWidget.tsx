import { getHeroById } from "../../src/services/heroCatalog";
import type { LocalMatchSummary, OverlayAnchor, RecentMatchesSettings } from "../types";
import styles from "./widget.module.scss";

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
export function RecentMatchesWidget({ matches, settings, anchor = "top-left" }: { matches: LocalMatchSummary[]; settings?: RecentMatchesSettings; anchor?: OverlayAnchor }) {
  const finalized = matches.filter((match) => match.result !== null);
  if (finalized.length === 0) return null;
  const ordered = settings?.direction === "oldest-first" ? [...finalized].reverse() : finalized;
  const visible = ordered.slice(0, settings?.limit ?? 8);
  const growUp = anchor.startsWith("bottom");

  return (
    <div className={styles.card}>
      <div className={`${styles.matchesList} ${growUp ? styles.matchesListGrowUp : styles.matchesListGrowDown}`}>
      {visible.map((match, index) => {
        const hero = getHeroById(match.heroId);
        const delta =
          match.ratingBefore !== null && match.ratingAfter !== null
            ? match.ratingAfter - match.ratingBefore
            : null;
        return (
          <div
            key={match.matchId ?? match.startedAt}
            className={styles.matchRow}
            title={hero?.localizedName}
          >
            {delta !== null && <span className={styles.matchIndex}>{index + 1}</span>}
            {hero && <img className={styles.heroIconTiny} src={hero.iconUrl} alt={hero.localizedName} />}
            {delta !== null && <span className={styles.matchKda}>{`${delta >= 0 ? "+" : ""}${delta}`}</span>}
            <span className={match.result === "win" ? styles.matchResultWin : match.result === "loss" ? styles.matchResultLoss : styles.matchResultAbandon}>{match.result === "win" ? "W" : match.result === "loss" ? "L" : "A"}</span>
          </div>
        );
      })}
      </div>
      {ordered.length > visible.length && <div className={styles.matchesOverflow}>+{ordered.length - visible.length} ещё</div>}
    </div>
  );
}
