import { useMemo } from "react";
import { motion } from "motion/react";
import { DOTA_HEROES } from "@/entities/dota-hero/model/heroes";
import { getHeroById } from "@/entities/dota-hero/lib/search";
import type { DotaHeroAttribute } from "@/entities/dota-hero/model/attributes";
import { getDraftSignals } from "../lib/get-draft-signals";
import { HeroMedia } from "../hero-media";
import { DraftSceneBackground } from "../draft-scene-background";
import { FrameCorners } from "../ui/frame-corners";
import { useFakeDraftController } from "./fake-draft-controller";
import styles from "./fake-draft-picker.module.scss";

interface FakeDraftPickerProps {
    payload: unknown;
    active?: boolean;
}

const HERO_POOL = DOTA_HEROES.map((hero) => hero.id);
// 9-11 видимых карточек на 1920x1080, как в старом Dota-пикере - контроллер
// уже поддерживает произвольный размер окна карусели, логика не меняется.
const CAROUSEL_WINDOW = 11;

const ATTRIBUTES: Array<{ id: DotaHeroAttribute; label: string }> = [
    { id: "strength", label: "STRENGTH" },
    { id: "agility", label: "AGILITY" },
    { id: "intelligence", label: "INTELLIGENCE" },
    { id: "universal", label: "UNIVERSAL" },
];

// Публичная "classic hero picker" сцена для protection.mode === "substitute" -
// целиком выдуманные пики, композиция намеренно скопирована со старого
// Dota hero picker (2012-2014). GSI используется только для одной вещи:
// узнать собственный реальный герой (если он уже известен) и НИКОГДА не
// показать его как fake pick - см. fake-draft-controller.ts.
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
        carouselWindow: CAROUSEL_WINDOW,
    });

    const focusedHero = snapshot.focusedHeroId ? getHeroById(snapshot.focusedHeroId) : undefined;
    const isLocked = snapshot.state === "lock" || snapshot.state === "wait";
    const statusLabel = isLocked ? "HERO LOCKED" : "YOUR TURN TO PICK";

    return (
        <div className={styles.layer} data-testid="fake-draft-picker">
            <DraftSceneBackground seed={741} />

            <div className={styles.picker}>
                {/* Единственное место, отражающее lock-состояние - раньше
                    рядом жил ещё и отдельный золотой badge поверх hero video,
                    дублируя тот же смысл двумя разными виджетами. */}
                <div className={`${styles.headerPlate} ${isLocked ? styles.headerLocked : ""}`}>
                    <span className={styles.status}>{statusLabel}</span>
                    <span className={styles.headerDivider} aria-hidden="true" />
                    <strong className={styles.countdown} data-testid="fake-countdown">
                        {String(snapshot.countdown).padStart(2, "0")}
                    </strong>
                </div>

                <div className={styles.showcase}>
                    <div className={`${styles.showcaseFrame} ${isLocked ? styles.locked : ""}`}>
                        <FrameCorners />
                        {focusedHero && (
                            <motion.div
                                key={focusedHero.id}
                                className={styles.showcaseHero}
                                initial={{ opacity: 0 }}
                                animate={{ opacity: 1 }}
                                transition={{ duration: 0.3 }}
                                data-testid="fake-focused-hero"
                                data-hero-id={focusedHero.id}
                            >
                                <HeroMedia
                                    videoSrc={focusedHero.featuredVideoUrl}
                                    imageSrc={focusedHero.imageUrl}
                                    title={focusedHero.localizedName}
                                />
                            </motion.div>
                        )}
                        {focusedHero && (
                            <div className={styles.namePlate}>
                                <strong>{focusedHero.localizedName}</strong>
                                <span className={styles.attributeTag}>
                                    {focusedHero.attribute.toUpperCase()}
                                </span>
                            </div>
                        )}
                    </div>
                </div>

                <div className={styles.carouselRow}>
                    <span className={styles.arrow} aria-hidden="true">
                        &#10094;
                    </span>
                    <div className={styles.carouselMask}>
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
                    </div>
                    <span className={styles.arrow} aria-hidden="true">
                        &#10095;
                    </span>
                </div>

                <div className={styles.controlPanel}>
                    <div className={styles.filters}>
                        {ATTRIBUTES.map((attribute) => (
                            <span
                                key={attribute.id}
                                className={`${styles.filter} ${styles[attribute.id]} ${
                                    focusedHero?.attribute === attribute.id ? styles.filterActive : ""
                                }`}
                            >
                                {attribute.label}
                            </span>
                        ))}
                    </div>
                    <div className={styles.actions}>
                        <span className={styles.randomButton}>RANDOM</span>
                        <span className={`${styles.pickButton} ${isLocked ? styles.pickButtonActive : ""}`}>
                            PICK
                        </span>
                    </div>
                </div>
            </div>
        </div>
    );
};
