import { useMemo } from "react";
import { DOTA_HEROES_BY_NAME } from "@/entities/dota-hero/model/heroes";
import { getDraftSignals } from "../lib/get-draft-signals";
import { DraftSceneBackground } from "../draft-scene-background";
import { HeroCarousel } from "./hero-carousel";
import { useFakeDraftController } from "./fake-draft-controller";
import styles from "./fake-draft-picker.module.scss";

interface FakeDraftPickerProps {
    payload: unknown;
    active?: boolean;
}

// Alphabetic roster (Abaddon -> Alchemist -> Ancient Apparition -> ...), как
// в старом Dota hero picker - см. DOTA_HEROES_BY_NAME.
const HERO_POOL = DOTA_HEROES_BY_NAME.map((hero) => hero.id);

// Публичная "classic hero picker" сцена для protection.mode === "substitute" -
// целиком выдуманные пики, композиция намеренно скопирована со старого
// Dota hero picker (2012-2014): одна большая пространственная карусель
// hero videos, без отдельного showcase/фильтров/кнопок. GSI используется
// только для одной вещи: узнать собственный реальный герой (если он уже
// известен) и НИКОГДА не показать его как fake pick - см.
// fake-draft-controller.ts.
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

    const isLocked = snapshot.state === "lock" || snapshot.state === "wait";
    const statusLabel = isLocked ? "HERO LOCKED" : "SELECT A HERO";
    // Во время scrolling лента едет к targetHeroId - именно он, а не старый
    // settledHeroId, должен быть "желаемым центром" для карусели прямо сейчас.
    const desiredCenterHeroId =
        snapshot.state === "scrolling" && snapshot.targetHeroId !== null
            ? snapshot.targetHeroId
            : snapshot.settledHeroId;

    return (
        <div className={styles.layer} data-testid="fake-draft-picker">
            <DraftSceneBackground seed={741} />

            <div className={styles.picker}>
                <div className={`${styles.headerPlate} ${isLocked ? styles.headerLocked : ""}`}>
                    <span className={styles.status}>{statusLabel}</span>
                    <span className={styles.headerDivider} aria-hidden="true" />
                    <strong className={styles.countdown} data-testid="fake-countdown">
                        {String(snapshot.countdown).padStart(2, "0")}
                    </strong>
                </div>

                <div className={styles.carouselStage}>
                    <HeroCarousel
                        roster={snapshot.roster}
                        centerHeroId={desiredCenterHeroId}
                        cycleId={snapshot.cycleId}
                        locked={isLocked}
                    />
                </div>
            </div>
        </div>
    );
};
