import { getHeroById } from "../../src/services/heroCatalog";
import type { CurrentGameSnapshot } from "../types";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import styles from "./widget.module.scss";

// WK-121 - "Current Game" widget: hero portrait/name + KDA while GSI
// reports an active hero (Draft/Gameplay). Hero name/icon resolution reuses
// the SAME heroCatalog.ts the rest of Companion (HomePage, Heroes section)
// already uses - no second hero-id mapping in this renderer.
export function CurrentGameWidget({ game }: { game: CurrentGameSnapshot | null }) {
  const reduced = useReducedMotion();
  if (!game?.heroId) return null;
  const hero = getHeroById(game.heroId);

  return (
    <div className={styles.card}>
      <AnimatePresence mode="wait"><motion.div key={game.heroId} className={styles.hero} initial={{ opacity: reduced ? 1 : 0 }} animate={{ opacity: 1 }} exit={{ opacity: reduced ? 1 : 0 }} transition={{ duration: reduced ? 0 : 0.2 }}>
        {hero && <img className={styles.heroIcon} src={hero.iconUrl} alt="" />}
        <span>{hero?.localizedName ?? `Герой #${game.heroId}`}{(game.kills !== null || game.deaths !== null || game.assists !== null) && <> · <span className={styles.matchKda}>{game.kills ?? 0} / {game.deaths ?? 0} / {game.assists ?? 0}</span></>}</span>
      </motion.div></AnimatePresence>
    </div>
  );
}
