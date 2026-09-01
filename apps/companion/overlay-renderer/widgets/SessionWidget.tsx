import type { LocalSessionSummary } from "../types";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import styles from "./widget.module.scss";

const medalFiles = import.meta.glob("../assets/rank-medals/*.png", { eager: true, import: "default" }) as Record<string, string>;
const rankThresholds = [
  ["herald", [0, 154, 308, 462, 616]],
  ["guardian", [770, 924, 1078, 1232, 1386]],
  ["crusader", [1540, 1694, 1848, 2002, 2156]],
  ["archon", [2310, 2464, 2618, 2772, 2926]],
  ["legend", [3080, 3234, 3388, 3542, 3696]],
  ["ancient", [3850, 4004, 4158, 4312, 4466]],
  ["divine", [4620, 4820, 5020, 5220, 5420]],
] as const;
function medalFor(rating: number | null): { src: string; label: string } | null {
  if (rating === null || rating < 0) return null;
  if (rating >= 5620) return { src: medalFiles["../assets/rank-medals/immortal.png"], label: "Immortal" };
  let result: { name: string; division: number } | null = null;
  for (const [name, thresholds] of rankThresholds) {
    for (let index = 0; index < thresholds.length; index += 1) {
      if (rating >= thresholds[index]) result = { name, division: index + 1 };
    }
  }
  return result ? { src: medalFiles[`../assets/rank-medals/${result.name}-${result.division}.png`], label: `${result.name} ${result.division}` } : null;
}

// Gameplay SessionStats keeps the production Web markup and styling while
// AnchoredBox applies the saved local layout shared by editor and OBS.
export function SessionWidget({ session, betweenMatches = false }: { session: LocalSessionSummary; big?: boolean; betweenMatches?: boolean }) {
  const reduced = useReducedMotion();
  if (!session.hasSession) return null;
  const delta = session.sessionDelta;
  const formattedDelta = delta === null || delta === 0 ? null : delta > 0 ? `+${delta}` : `${delta}`;

  return (
    <div className={styles.card}>
      {medalFor(session.ratingCurrent) && <img className={styles.medal} src={medalFor(session.ratingCurrent)!.src} alt={`${medalFor(session.ratingCurrent)!.label} rank medal`} />}
      <div className={styles.stats}>
        {session.ratingCurrent !== null && <AnimatePresence mode="wait"><motion.div key={`${session.ratingCurrent}-${delta}`} className={styles.rating} initial={{ opacity: reduced ? 1 : 0 }} animate={{ opacity: 1 }} exit={{ opacity: reduced ? 1 : 0 }} transition={{ duration: reduced ? 0 : 0.2 }}>{session.ratingCurrent} MMR{formattedDelta !== null && <span className={delta! > 0 ? styles.sessionDeltaPositive : styles.sessionDeltaNegative}>{betweenMatches ? ` (${formattedDelta})` : ` (${formattedDelta})`}</span>}</motion.div></AnimatePresence>}
        <div className={styles.record}><span>{session.wins}W</span> / <span>{session.losses}L</span></div>
      </div>
    </div>
  );
}
