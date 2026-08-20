"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import {
    SAFE_AREA_PERCENT,
    type OverlayAspectRatio,
    type MinimapCoverSettings,
    type DraftProtectionMode,
} from "@/entities/stream-overlay-layout/model/types";
import { computeSceneDimensions } from "@/entities/stream-overlay-layout/lib/scene-dimensions";
import { GameUiReferenceLayer, type ReferenceBackgroundImage } from "./game-ui-reference-layer";
import { AntiSnipeLayer } from "./anti-snipe-layer";
import { DraftProtectionLayer } from "./draft-protection-layer";
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
    minimapCover?: MinimapCoverSettings;
    draftProtectionMode?: DraftProtectionMode;
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
    minimapCover,
    draftProtectionMode,
    referenceBackground = null,
    children,
}: OverlayCanvasProps) => {
    const viewportRef = useRef<HTMLDivElement>(null);
    // scale = Math.max(...) ("cover", не "contain") + offsetX/Y центрируют
    // отмасштабированную сцену в viewport - раньше scale брался через
    // Math.min и .canvas был прижат к top-left без центрирования, поэтому
    // при любом расхождении реального viewport с 16:9 (например, вкладка
    // браузера при прямом открытии /overlay/:token - системный UI чуть
    // меняет высоту относительно 1920x1080) справа/снизу оставалась
    // незакрытая полоса viewport'а, которая из-за прозрачного фона
    // (см. .viewportLive) просвечивала белым фоном страницы. Cover-fit
    // гарантирует, что сцена всегда полностью покрывает viewport (излишек
    // уходит в overflow: hidden), сохраняя пропорции - без white/empty gap.
    const [transform, setTransform] = useState({ scale: 1, offsetX: 0, offsetY: 0 });
    const { width: sceneWidth, height: sceneHeight } =
        computeSceneDimensions(aspectRatio);

    useEffect(() => {
        const el = viewportRef.current;
        if (!el) return;

        const measure = () => {
            const rect = el.getBoundingClientRect();
            if (rect.width === 0 || rect.height === 0) return;
            const scale = Math.max(rect.width / sceneWidth, rect.height / sceneHeight);
            setTransform({
                scale,
                offsetX: (rect.width - sceneWidth * scale) / 2,
                offsetY: (rect.height - sceneHeight * scale) / 2,
            });
        };

        measure();
        const observer = new ResizeObserver(measure);
        observer.observe(el);
        return () => observer.disconnect();
    }, [sceneWidth, sceneHeight]);

    const { scale: sceneScale, offsetX, offsetY } = transform;

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
                    transform: `translate(${offsetX}px, ${offsetY}px) scale(${sceneScale})`,
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
                <AntiSnipeLayer
                    sceneWidth={sceneWidth}
                    sceneHeight={sceneHeight}
                    settings={minimapCover}
                />
                {draftProtectionMode && (
                    <DraftProtectionLayer mode={draftProtectionMode} />
                )}
                {children({ sceneScale, sceneWidth, sceneHeight })}
            </div>
        </div>
    );
};
