import { AnimatePresence, motion } from "motion/react";
import { getHeroById } from "@/entities/dota-hero/lib/search";
import styles from "./widget.module.scss";

interface CurrentGameProps {
    lastHeroId: number | null;
}

const FADE_TRANSITION = { duration: 0.2 };

export const CurrentGame = ({ lastHeroId }: CurrentGameProps) => {
    const hero = lastHeroId ? getHeroById(lastHeroId) : undefined;
    if (!hero) return null;

    return (
        <div className={styles.card}>
            <AnimatePresence mode="wait">
                <motion.div
                    key={hero.id}
                    className={styles.hero}
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={FADE_TRANSITION}
                >
                    <img
                        src={hero.imageUrl}
                        alt=""
                        title={hero.localizedName}
                        className={styles.heroIcon}
                        onError={(event) => {
                            event.currentTarget.style.visibility = "hidden";
                        }}
                    />
                    {hero.localizedName}
                </motion.div>
            </AnimatePresence>
        </div>
    );
};
