import { useEffect, useRef, useState } from "react";
import { animate, motion, useMotionValue, useMotionValueEvent, useTransform, type MotionValue } from "motion/react";
import { getHeroById } from "@/entities/dota-hero/lib/search";
import type { DotaHero } from "@/entities/dota-hero/model/types";
import { HeroMedia } from "../hero-media";
import { FrameCorners } from "../ui/frame-corners";
import styles from "./hero-carousel.module.scss";

interface HeroCarouselProps {
    // Стабильный alphabetic roster (см. fake-draft-controller.ts) - позиция
    // в этом массиве и есть пространственная позиция карточки на ленте.
    roster: number[];
    // Герой, к которому лента должна быть отцентрована прямо сейчас -
    // settled hero в состояниях idle/lock/wait, либо target hero во время
    // scrolling. Selected state целиком определяется этим - нет отдельного
    // CURRENT/selected-badge.
    centerHeroId: number | null;
    // Меняется только на новую fake-pick сессию (enter -> idle) - сигнал
    // рендер-слою мгновенно перескочить на новую стартовую позицию вместо
    // того, чтобы физически проскроллить через весь ростер до неё.
    cycleId: number;
    locked: boolean;
}

// Дистанция между соседними слотами и радиусы preload-окна - см. задачу:
// "5-7 крупных hero videos видимо и играет + preload несколько слева/справа,
// итого не больше ~15-20 одновременно подготовленных videos".
const SLOT_STEP = 230;
const ACTIVE_RADIUS = 3;
const OVERSCAN_RADIUS = 7;

const clampNum = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

interface IndexRange {
    start: number;
    end: number;
}

const clampRange = (range: IndexRange, length: number): IndexRange => {
    if (length === 0) return { start: 0, end: -1 };
    return {
        start: clampNum(range.start, 0, length - 1),
        end: clampNum(range.end, 0, length - 1),
    };
};

export const HeroCarousel = ({ roster, centerHeroId, cycleId, locked }: HeroCarouselProps) => {
    const initialIndex = centerHeroId !== null ? Math.max(roster.indexOf(centerHeroId), 0) : 0;
    const centerIndexMV = useMotionValue(initialIndex);
    const [roundedCenter, setRoundedCenter] = useState(initialIndex);
    const roundedCenterRef = useRef(initialIndex);
    const lastCycleIdRef = useRef(cycleId);
    const [mountRange, setMountRange] = useState<IndexRange>(() =>
        clampRange({ start: initialIndex - OVERSCAN_RADIUS, end: initialIndex + OVERSCAN_RADIUS }, roster.length)
    );

    useMotionValueEvent(centerIndexMV, "change", (value) => {
        const rounded = Math.round(value);
        if (rounded !== roundedCenterRef.current) {
            roundedCenterRef.current = rounded;
            setRoundedCenter(rounded);
        }
    });

    useEffect(() => {
        if (centerHeroId === null || roster.length === 0) return;
        const targetIndex = roster.indexOf(centerHeroId);
        if (targetIndex === -1) return;

        const isNewSession = cycleId !== lastCycleIdRef.current;
        lastCycleIdRef.current = cycleId;

        if (isNewSession) {
            // Новая fake-pick сессия начинается со свежей случайной позиции -
            // это не "человек листает соседей", а сброс на новый раунд, так
            // что лента должна мгновенно оказаться там, без прокрутки через
            // десятки промежуточных героев (см. controller: cycleId).
            centerIndexMV.set(targetIndex);
            roundedCenterRef.current = targetIndex;
            setRoundedCenter(targetIndex);
            setMountRange(clampRange({ start: targetIndex - OVERSCAN_RADIUS, end: targetIndex + OVERSCAN_RADIUS }, roster.length));
            return;
        }

        const fromIndex = Math.round(centerIndexMV.get());

        // Preload весь путь, который лента вот-вот физически пройдёт, а не
        // только пункт назначения - соседние герои должны быть готовы кадром
        // раньше, чем они попадут в viewport (см. задачу: "карточки, которые
        // скоро попадут в viewport при scroll, должны начать загрузку
        // заранее").
        setMountRange((prev) =>
            clampRange(
                {
                    start: Math.min(prev.start, Math.min(fromIndex, targetIndex) - ACTIVE_RADIUS),
                    end: Math.max(prev.end, Math.max(fromIndex, targetIndex) + ACTIVE_RADIUS),
                },
                roster.length
            )
        );

        const distance = Math.abs(targetIndex - fromIndex);
        const controls = animate(centerIndexMV, targetIndex, {
            type: "tween",
            ease: "easeInOut",
            duration: clampNum(0.32 + distance * 0.055, 0.32, 1.15),
            onComplete: () => {
                // Осесть обратно на компактное cache-окно вокруг точки
                // остановки - недавно пройденные герои остаются
                // смонтированными ещё немного (overscan), чтобы движение
                // назад не вызывало мгновенную повторную загрузку.
                setMountRange(
                    clampRange({ start: targetIndex - OVERSCAN_RADIUS, end: targetIndex + OVERSCAN_RADIUS }, roster.length)
                );
            },
        });
        return () => controls.stop();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [centerHeroId, cycleId, roster]);

    if (centerHeroId === null) {
        return <div className={styles.stage} data-testid="fake-carousel" />;
    }

    const cardIndices: number[] = [];
    for (let index = mountRange.start; index <= mountRange.end; index++) cardIndices.push(index);

    return (
        <div className={styles.stage} data-testid="fake-carousel">
            <div className={styles.ribbon}>
                {cardIndices.map((index) => {
                    const heroId = roster[index];
                    const hero = heroId !== undefined ? getHeroById(heroId) : undefined;
                    if (!hero) return null;
                    const isCenter = index === roundedCenter;
                    const active = Math.abs(index - roundedCenter) <= ACTIVE_RADIUS;
                    return (
                        <HeroCarouselCard
                            key={hero.id}
                            index={index}
                            hero={hero}
                            centerIndexMV={centerIndexMV}
                            active={active}
                            isCenter={isCenter}
                            locked={locked && isCenter}
                        />
                    );
                })}
            </div>
        </div>
    );
};

interface HeroCarouselCardProps {
    index: number;
    hero: DotaHero;
    centerIndexMV: MotionValue<number>;
    active: boolean;
    isCenter: boolean;
    locked: boolean;
}

const HeroCarouselCard = ({ index, hero, centerIndexMV, active, isCenter, locked }: HeroCarouselCardProps) => {
    const distance = useTransform(centerIndexMV, (v) => Math.abs(index - v));
    const x = useTransform(centerIndexMV, (v) => (index - v) * SLOT_STEP);
    const y = useTransform(distance, (d) => Math.min(d, 6) * 5);
    const scale = useTransform(distance, (d) => clampNum(1 - d * 0.12, 0.52, 1));
    const opacity = useTransform(distance, (d) => clampNum(1 - d * 0.17, 0.22, 1));
    const brightness = useTransform(distance, (d) => clampNum(1 - d * 0.14, 0.34, 1));
    const filter = useTransform(brightness, (b) => `brightness(${b})`);
    const zIndex = useTransform(distance, (d) => Math.round(100 - d));

    return (
        <motion.div
            className={`${styles.card} ${isCenter ? styles.cardCenter : ""} ${locked ? styles.cardLocked : ""}`}
            style={{ x, y, scale, opacity, filter, zIndex }}
            data-testid={isCenter ? "fake-focused-hero" : undefined}
            data-hero-id={hero.id}
        >
            {isCenter && <FrameCorners />}
            <HeroMedia
                videoSrc={hero.featuredVideoUrl}
                imageSrc={hero.imageUrl}
                title={hero.localizedName}
                paused={!active}
                className={styles.cardMedia}
            />
            {isCenter && (
                <div className={styles.namePlate}>
                    <strong>{hero.localizedName}</strong>
                </div>
            )}
        </motion.div>
    );
};
