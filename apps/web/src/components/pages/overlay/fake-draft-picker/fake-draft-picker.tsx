import { useMemo } from "react";
import { motion } from "motion/react";
import { DOTA_HEROES } from "@/entities/dota-hero/model/heroes";
import { getHeroById } from "@/entities/dota-hero/lib/search";
import { getDraftSignals } from "../lib/get-draft-signals";
import { HeroMedia } from "../hero-media";
import { useFakeDraftController } from "./fake-draft-controller";
import styles from "./fake-draft-picker.module.scss";

interface FakeDraftPickerProps {
    payload: unknown;
    active?: boolean;
}

const HERO_POOL = DOTA_HEROES.map((hero) => hero.id);

// Публичная "classic hero picker" сцена для protection.mode === "substitute" -
// целиком выдуманные пики. GSI используется только для одной вещи: узнать
// собственный реальный герой (если он уже известен) и НИКОГДА не показать
// его как fake pick - см. fake-draft-controller.ts и задачу WK-77.
export const FakeDraftPicker = ({ payload, active = true }: FakeDraftPickerProps) => {
    const { hero: knownHero } = getDraftSignals(payload);
    const excludedHeroIds = useMemo(
        () => (knownHero ? [knownHero.id] : []),
        [knownHero]
    );

    const snapshot = useFakeDraftController({
        heroPool: HERO_POOL,
        excludedHeroIds,
        active,
    });

    const focusedHero = snapshot.focusedHeroId ? getHeroById(snapshot.focusedHeroId) : undefined;
    const isLocked = snapshot.state === "lock" || snapshot.state === "wait";

    return (
        <div className={styles.layer} data-testid="fake-draft-picker">
            <div className={styles.heading}>
                <span>PUBLIC DRAFT</span>
                <strong className={styles.countdown} data-testid="fake-countdown">
                    {String(snapshot.countdown).padStart(2, "0")}
                </strong>
            </div>

            <div className={styles.focus}>
                {focusedHero && (
                    <motion.div
                        key={focusedHero.id}
                        className={`${styles.focusedHero} ${isLocked ? styles.locked : ""}`}
                        initial={{ opacity: 0, scale: 0.96 }}
                        animate={{ opacity: 1, scale: 1 }}
                        transition={{ duration: 0.25 }}
                        data-testid="fake-focused-hero"
                        data-hero-id={focusedHero.id}
                    >
                        <HeroMedia
                            videoSrc={focusedHero.featuredVideoUrl}
                            imageSrc={focusedHero.imageUrl}
                            title={focusedHero.localizedName}
                        />
                        <span className={styles.focusedName}>{focusedHero.localizedName}</span>
                        {isLocked && <span className={styles.lockBadge}>LOCKED</span>}
                    </motion.div>
                )}
            </div>

            <div className={styles.carousel} data-testid="fake-carousel">
                {snapshot.carouselHeroIds.map((heroId) => {
                    const hero = getHeroById(heroId);
                    if (!hero) return null;
                    const isFocused = heroId === snapshot.focusedHeroId;
                    const isHovered = heroId === snapshot.hoverHeroId;
                    return (
                        <div
                            key={hero.id}
                            className={`${styles.card} ${isFocused ? styles.cardFocused : ""} ${isHovered ? styles.cardHovered : ""}`}
                        >
                            <img src={hero.imageUrl} alt={hero.localizedName} className={styles.cardImage} />
                        </div>
                    );
                })}
            </div>

            <p className={styles.disclaimer}>Публичная композиция не связана с реальными пиками и банами.</p>
        </div>
    );
};
