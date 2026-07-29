"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import {
    SAFE_AREA_PERCENT,
    type OverlayAspectRatio,
} from "@/entities/stream-overlay-layout/model/types";
import { computeSceneDimensions } from "@/entities/stream-overlay-layout/lib/scene-dimensions";
import { GameUiReferenceLayer, type ReferenceBackgroundImage } from "./game-ui-reference-layer";
import { AntiSnipeLayer } from "./anti-snipe-layer";
import styles from "./overlay-canvas.module.scss";

export interface OverlaySceneContext {
    // Множитель между экранными px контейнера (viewport) и логическими px
    // виртуальной сцены - и live-overlay, и editor-превью рендерят СЦЕНУ
    // одинаково, разница только в том, сколько реальных px ей отведено
    // снаружи. Нужен потребителям только для перевода PointerEvent дельт
    // (реальные экранные px) в scene-единицы: deltaScene = deltaClient /
    // sceneScale (см. draggable-widget.tsx).
    sceneScale: number;
    // Логические px виртуальной сцены (ширина фиксирована, высота зависит от
    // aspectRatio) - передаются потребителям, чтобы AnchoredWidget не
    // предполагал 1920x1080 напрямую (см. задачу "не хардкодить 1920x1080").
    sceneWidth: number;
    sceneHeight: number;
}

interface OverlayCanvasProps {
    mode: "preview" | "live";
    // Определяет sceneWidth/sceneHeight (см. computeSceneDimensions) - тот же
    // aspectRatio, что хранится в OverlayLayout, всегда передаётся вызывающей
    // страницей (редактор - из draft-layout, live overlay - из последнего
    // polled layout).
    aspectRatio: OverlayAspectRatio;
    // Только editor передаёt true - см. задачу п.9 ("не рендерится в live
    // overlay").
    showSafeArea?: boolean;
    // "Фон для примерки" (см. задачу) - только editor читает его из
    // IndexedDB и передаёт сюда; live overlay (/overlay/:token) этот проп
    // никогда не передаёт, а GameUiReferenceLayer вдобавок сам игнорирует
    // его при mode !== "preview" (двойная защита от утечки в публичный
    // overlay).
    referenceBackground?: ReferenceBackgroundImage | null;
    children: (ctx: OverlaySceneContext) => ReactNode;
}

// Общий рендер-примитив реального /overlay/:token И превью
// /stream/overlay-editor - раньше это были две независимые системы координат
// (vw/vh + clamp() на live, проценты произвольного превью-контейнера в
// editor), которые физически не могли совпадать. Теперь оба режима всегда
// рендерят одну и ту же виртуальную сцену (ширина фиксирована, высота
// вычисляется из aspectRatio - см. entities/stream-overlay-layout/lib/
// scene-dimensions.ts) и просто по-разному её масштабируют под то, сколько
// реальных px им отведено - при точном совпадении соотношения сторон масштаб
// между двумя любыми целевыми размерами меняется строго линейно и одинаково
// для обоих режимов.
export const OverlayCanvas = ({
    mode,
    aspectRatio,
    showSafeArea = false,
    referenceBackground = null,
    children,
}: OverlayCanvasProps) => {
    const viewportRef = useRef<HTMLDivElement>(null);
    const [sceneScale, setSceneScale] = useState(1);
    const { width: sceneWidth, height: sceneHeight } =
        computeSceneDimensions(aspectRatio);

    useEffect(() => {
        const el = viewportRef.current;
        if (!el) return;

        const measure = () => {
            const rect = el.getBoundingClientRect();
            if (rect.width === 0 || rect.height === 0) return;
            setSceneScale(
                Math.min(rect.width / sceneWidth, rect.height / sceneHeight)
            );
        };

        measure();
        const observer = new ResizeObserver(measure);
        observer.observe(el);
        return () => observer.disconnect();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [sceneWidth, sceneHeight]);

    const safeAreaXPx = (SAFE_AREA_PERCENT / 100) * sceneWidth;
    const safeAreaYPx = (SAFE_AREA_PERCENT / 100) * sceneHeight;

    return (
        <div
            ref={viewportRef}
            className={
                mode === "live" ? styles.viewportLive : styles.viewportPreview
            }
        >
            <div
                className={styles.canvas}
                style={{
                    width: sceneWidth,
                    height: sceneHeight,
                    transform: `scale(${sceneScale})`,
                }}
            >
                {showSafeArea && (
                    <div
                        className={styles.safeArea}
                        style={{
                            left: safeAreaXPx,
                            top: safeAreaYPx,
                            width: sceneWidth - safeAreaXPx * 2,
                            height: sceneHeight - safeAreaYPx * 2,
                        }}
                    />
                )}
                {/* Точки расширения под будущие фазы (см. задачу, п.10) -
                    сейчас обе возвращают null, DOM не добавляют. Порядок
                    соответствует эскизу задачи: game-UI reference -> anti-snipe
                    -> widgets (рендерятся вызывающей стороной через children) ->
                    editor-guides (safeArea/snap выше уже часть editor-only рендера). */}
                <GameUiReferenceLayer
                    sceneWidth={sceneWidth}
                    sceneHeight={sceneHeight}
                    mode={mode}
                    referenceImage={referenceBackground}
                />
                <AntiSnipeLayer sceneWidth={sceneWidth} sceneHeight={sceneHeight} />
                {children({ sceneScale, sceneWidth, sceneHeight })}
            </div>
        </div>
    );
};
