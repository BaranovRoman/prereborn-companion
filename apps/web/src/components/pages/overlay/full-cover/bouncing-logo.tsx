"use client";

import { useEffect, useRef } from "react";
import { SAFE_AREA_PERCENT } from "@/entities/stream-overlay-layout/model/types";
import styles from "./bouncing-logo.module.scss";

// Постоянная линейная скорость полёта (px/сек в логических px сцены, т.е.
// не зависит от sceneScale - см. overlay-canvas.tsx: инсет-контейнер ниже
// измеряется через clientWidth/clientHeight, которые CSS-scale родителя не
// трогает).
const SPEED_PX_PER_SEC = 150;
const LOGO_SIZE_FRACTION = 0.22; // доля меньшей стороны size-basis (см. measure())
// Size-basis остаётся привязан к прежним safe-area пропорциям (0.93 = 1 -
// 2*3.5%), чтобы визуальный размер логотипа не изменился при переходе
// границ отскока на реальный viewport (см. задачу: "существующий размер
// логотипа" сохранить, а safe-area для физики убрать).
const SIZE_BASIS_FRACTION = 1 - (SAFE_AREA_PERCENT * 2) / 100;
const MIN_HUE_JUMP_DEG = 70; // "заметно отличающийся" hue при столкновении

const pickNextHue = (currentHue: number): number => {
    for (let attempt = 0; attempt < 8; attempt++) {
        const candidate = Math.floor(Math.random() * 360);
        const delta = Math.min(
            Math.abs(candidate - currentHue),
            360 - Math.abs(candidate - currentHue)
        );
        if (delta >= MIN_HUE_JUMP_DEG) return candidate;
    }
    // Крайне маловероятный fallback (8 промахов подряд) - всё равно даёт
    // заметный скачок за счёт свойства HSV-круга.
    return (currentHue + 180) % 360;
};

// DVD-screensaver ФИЗИКА (постоянная скорость, диагональное движение, жёсткое
// без-easing отражение от границ) применена к Prereborn logo - идея взята
// СТРОГО из физики движения, не из визуала DVD-заставки (см. задачу п.3).
// Цвет меняется дискретно через hue-rotate только в момент столкновения -
// не анимируется непрерывно во время полёта.
export const BouncingLogo = () => {
    const containerRef = useRef<HTMLDivElement>(null);
    const logoRef = useRef<HTMLImageElement>(null);

    useEffect(() => {
        const container = containerRef.current;
        const logo = logoRef.current;
        if (!container || !logo) return;

        const reducedMotionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");

        let disposed = false;
        let animationFrame = 0;
        let lastTime = 0;
        let width = 0;
        let height = 0;
        let logoSize = 0;
        let x = 0;
        let y = 0;
        let vx = 0;
        let vy = 0;
        let hue = Math.floor(Math.random() * 360);

        const applyHue = () => {
            logo.style.filter = `hue-rotate(${hue}deg) drop-shadow(0 0 26px hsla(${hue}, 85%, 62%, 0.4))`;
        };

        const measure = () => {
            width = container.clientWidth;
            height = container.clientHeight;
            const sizeBasis = Math.min(width, height) * SIZE_BASIS_FRACTION;
            logoSize = sizeBasis * LOGO_SIZE_FRACTION;
            logo.style.width = `${logoSize}px`;
            logo.style.height = `${logoSize}px`;
            // Границы отскока - реальный viewport (0..width/height), без
            // safe-area отступа: логотип должен доходить bounding box'ом
            // ровно до края экрана.
            const maxX = Math.max(width - logoSize, 0);
            const maxY = Math.max(height - logoSize, 0);
            x = Math.min(Math.max(x, 0), maxX);
            y = Math.min(Math.max(y, 0), maxY);
        };

        const paint = () => {
            logo.style.transform = `translate3d(${x}px, ${y}px, 0)`;
        };

        // prefers-reduced-motion: логотип остаётся неподвижен по центру -
        // не ломаем существующую accessibility-стратегию проекта (см. ту же
        // проверку в red-fog-background.tsx).
        const layoutStatic = () => {
            const maxX = Math.max(width - logoSize, 0);
            const maxY = Math.max(height - logoSize, 0);
            x = maxX / 2;
            y = maxY / 2;
            paint();
        };

        const tick = (time: number) => {
            if (disposed) return;
            const dt = Math.min((time - lastTime) / 1000, 0.05);
            lastTime = time;

            const maxX = Math.max(width - logoSize, 0);
            const maxY = Math.max(height - logoSize, 0);
            let nextX = x + vx * dt;
            let nextY = y + vy * dt;
            let collided = false;

            if (nextX <= 0) {
                nextX = 0;
                vx = Math.abs(vx);
                collided = true;
            } else if (nextX >= maxX) {
                nextX = maxX;
                vx = -Math.abs(vx);
                collided = true;
            }

            if (nextY <= 0) {
                nextY = 0;
                vy = Math.abs(vy);
                collided = true;
            } else if (nextY >= maxY) {
                nextY = maxY;
                vy = -Math.abs(vy);
                collided = true;
            }

            x = nextX;
            y = nextY;
            paint();

            if (collided) {
                hue = pickNextHue(hue);
                applyHue();
            }

            animationFrame = requestAnimationFrame(tick);
        };

        const start = () => {
            disposed = false;
            measure();
            applyHue();

            if (reducedMotionQuery.matches) {
                layoutStatic();
                return;
            }

            const maxX = Math.max(width - logoSize, 0);
            const maxY = Math.max(height - logoSize, 0);
            x = Math.random() * maxX;
            y = Math.random() * maxY;
            const angle = Math.random() * Math.PI * 2;
            vx = Math.cos(angle) * SPEED_PX_PER_SEC;
            vy = Math.sin(angle) * SPEED_PX_PER_SEC;
            paint();

            lastTime = performance.now();
            animationFrame = requestAnimationFrame(tick);
        };

        const stop = () => {
            disposed = true;
            cancelAnimationFrame(animationFrame);
        };

        start();

        const resizeObserver = new ResizeObserver(() => {
            measure();
            if (reducedMotionQuery.matches) layoutStatic();
            else paint();
        });
        resizeObserver.observe(container);

        const handleMotionPreferenceChange = () => {
            stop();
            start();
        };
        reducedMotionQuery.addEventListener("change", handleMotionPreferenceChange);

        return () => {
            stop();
            resizeObserver.disconnect();
            reducedMotionQuery.removeEventListener("change", handleMotionPreferenceChange);
        };
    }, []);

    return (
        <div ref={containerRef} className={styles.viewport} aria-hidden="true">
            <img ref={logoRef} src="/logo-new.png" alt="" className={styles.logo} />
        </div>
    );
};
