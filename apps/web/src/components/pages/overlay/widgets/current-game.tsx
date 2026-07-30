import { useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { getHeroById } from "@/entities/dota-hero/lib/search";
import styles from "./widget.module.scss";

interface CurrentGameProps {
    lastHeroId: number | null;
}

const FADE_TRANSITION = { duration: 0.2 };

const HeroVideo = ({
    src,
    poster,
    title,
}: {
    src: string;
    poster: string;
    title: string;
}) => {
    const [videoReady, setVideoReady] = useState(false);

    return (
        <span className={styles.heroMedia}>
            <img src={poster} alt="" aria-hidden="true" className={styles.heroIcon} />
            <video
                src={src}
                poster={poster}
                title={title}
                className={styles.heroIcon}
                preload="auto"
                autoPlay
                loop
                muted
                playsInline
                onLoadedData={() => setVideoReady(true)}
                onCanPlay={() => setVideoReady(true)}
                onPlaying={() => setVideoReady(true)}
                onWaiting={() => setVideoReady(false)}
                onStalled={() => setVideoReady(false)}
                onError={() => setVideoReady(false)}
                style={{
                    opacity: videoReady ? 1 : 0,
                    transition: "opacity 220ms ease",
                }}
            />
        </span>
    );
};

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
                    <HeroVideo
                        key={hero.id}
                        src={hero.favoriteVideoUrl}
                        poster={hero.imageUrl}
                        title={hero.localizedName}
                    />
                    {hero.localizedName}
                </motion.div>
            </AnimatePresence>
        </div>
    );
};
