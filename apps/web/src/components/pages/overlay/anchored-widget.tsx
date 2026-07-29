"use client";

import {
    useEffect,
    useLayoutEffect,
    useRef,
    useState,
    type PointerEvent as ReactPointerEvent,
    type ReactNode,
} from "react";
import {
    SAFE_AREA_PERCENT,
    type OverlayWidgetLayout,
} from "@/entities/stream-overlay-layout/model/types";
import { anchorFraction } from "@/entities/stream-overlay-layout/lib/anchor";
import {
    buildSceneGuides,
    buildSafeAreaGuides,
    buildWidgetGuidesForAxis,
    resolveAxisSnap,
    type OtherWidgetBounds,
    type SnapGuide,
} from "@/entities/stream-overlay-layout/lib/snap";

const EDITOR_SNAP_THRESHOLD_PX = 10;
const WIDGET_SNAP_GAP = 24;

interface DraftPosition {
    xVw: number;
    yVh: number;
}

export interface SnapGuideState {
    x: SnapGuide | null;
    y: SnapGuide | null;
}

export interface WidgetBounds {
    left: number;
    top: number;
    width: number;
    height: number;
}

export interface AnchoredWidgetInteractive {
    sceneScale: number;
    // Bounding box'ы ДРУГИХ видимых виджетов сцены (без самого себя) - для
    // snapping к их краям/центру/стандартному отступу (см. задачу, п.6).
    // Собирается редактором из onBoundsChange всех виджетов.
    otherWidgetsBounds: OtherWidgetBounds[];
    // Anchor НИКОГДА не меняется через drag (см. задачу, п.1) - коммитим
    // только координаты.
    onCommitPosition: (xVw: number, yVh: number) => void;
    onSnapGuidesChange?: (guides: SnapGuideState) => void;
    // Текущий (уже отмасштабированный) bounding box виджета в scene px -
    // репортится при каждом изменении размера/позиции/видимости, не только
    // во время drag. Редактор использует это и для построения
    // otherWidgetsBounds остальных виджетов, и для пересчёта позиции при
    // смене anchor через сетку (см. задачу, п.2).
    onBoundsChange?: (bounds: WidgetBounds | null) => void;
}

interface AnchoredWidgetProps {
    layout: OverlayWidgetLayout;
    children: ReactNode;
    // Логические px виртуальной сцены (см. OverlaySceneContext) - не
    // предполагаем 1920x1080 напрямую, сцена может быть уже/шире в
    // зависимости от aspectRatio (см. задачу "aspect ratio сцены").
    sceneWidth: number;
    sceneHeight: number;
    // Присутствует только в редакторе - если задан, виджет перетаскиваемый
    // через Pointer Events. На реальном /overlay/:token не передаётся -
    // рендер там абсолютно нейтральный (просто позиционированный div).
    interactive?: AnchoredWidgetInteractive;
}

// Единственное место, где xVw/yVh/anchor/scale превращаются в реальные
// left/top - используется и реальным /overlay/:token (interactive не
// передан), и /stream/overlay-editor (interactive передан). Anchor задаёт,
// какая ТОЧКА виджета сидит в (xVw, yVh) - измеряем фактический (уже
// отмасштабированный локальным widget.scale) размер через ResizeObserver.
//
// Anchor изменяется ТОЛЬКО явно - через сетку 3x3 в панели виджета
// (см. overlay-editor/index.tsx) или применением preset'а. Drag и snapping
// здесь трогают ИСКЛЮЧИТЕЛЬНО xVw/yVh (см. задачу, п.1) - anchor виджета
// фиксирован на весь жест drag и используется просто как константа для
// перевода box-start <-> anchor-точка.
export const AnchoredWidget = ({
    layout,
    children,
    sceneWidth,
    sceneHeight,
    interactive,
}: AnchoredWidgetProps) => {
    const contentRef = useRef<HTMLDivElement>(null);
    const [size, setSize] = useState({ width: 0, height: 0 });
    const [isDragging, setIsDragging] = useState(false);
    const [draft, setDraft] = useState<DraftPosition | null>(null);
    const dragStartRef = useRef<{
        clientX: number;
        clientY: number;
        boxStartX: number;
        boxStartY: number;
    } | null>(null);

    useLayoutEffect(() => {
        const el = contentRef.current;
        if (!el) return;
        const measure = () =>
            setSize({ width: el.offsetWidth, height: el.offsetHeight });
        measure();
        const observer = new ResizeObserver(measure);
        observer.observe(el);
        return () => observer.disconnect();
    }, []);

    const effective: OverlayWidgetLayout =
        isDragging && draft ? { ...layout, ...draft } : layout;

    const frac = anchorFraction(effective.anchor);
    const anchorPointXPx = (effective.xVw / 100) * sceneWidth;
    const anchorPointYPx = (effective.yVh / 100) * sceneHeight;
    const scaledWidth = size.width * layout.scale;
    const scaledHeight = size.height * layout.scale;

    const wrapperLeft = anchorPointXPx - frac.x * scaledWidth;
    const wrapperTop = anchorPointYPx - frac.y * scaledHeight;

    // Репортим текущий bounding box наружу при любом изменении - не только
    // во время drag (редактору нужны АКТУАЛЬНЫЕ границы всех остальных
    // видимых виджетов в любой момент, чтобы snapping и "сохранить
    // визуальное положение при смене anchor" работали корректно).
    useEffect(() => {
        if (!interactive?.onBoundsChange) return;
        if (!layout.visible) {
            interactive.onBoundsChange(null);
            return;
        }
        interactive.onBoundsChange({
            left: wrapperLeft,
            top: wrapperTop,
            width: scaledWidth,
            height: scaledHeight,
        });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [wrapperLeft, wrapperTop, scaledWidth, scaledHeight, layout.visible]);

    if (!layout.visible) return null;

    const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
        if (!interactive) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        dragStartRef.current = {
            clientX: event.clientX,
            clientY: event.clientY,
            boxStartX: wrapperLeft,
            boxStartY: wrapperTop,
        };
        setIsDragging(true);
    };

    const updateDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
        if (!interactive || !dragStartRef.current) return;
        const start = dragStartRef.current;
        const { sceneScale } = interactive;

        // Реальные экранные px курсора -> scene-единицы: drag в
        // уменьшенном превью не должен напрямую записывать экранные px.
        const deltaSceneX = (event.clientX - start.clientX) / sceneScale;
        const deltaSceneY = (event.clientY - start.clientY) / sceneScale;

        let candidateLeft = start.boxStartX + deltaSceneX;
        let candidateTop = start.boxStartY + deltaSceneY;

        // Фактический (уже scaled) bounding box - не даём виджету уйти
        // полностью за сцену.
        candidateLeft = Math.min(
            Math.max(candidateLeft, 0),
            Math.max(0, sceneWidth - scaledWidth)
        );
        candidateTop = Math.min(
            Math.max(candidateTop, 0),
            Math.max(0, sceneHeight - scaledHeight)
        );

        const thresholdScene = EDITOR_SNAP_THRESHOLD_PX / sceneScale;
        const safeAreaXPx = (SAFE_AREA_PERCENT / 100) * sceneWidth;
        const safeAreaYPx = (SAFE_AREA_PERCENT / 100) * sceneHeight;

        const xGuides = [
            ...buildSceneGuides(sceneWidth),
            ...buildSafeAreaGuides(sceneWidth, safeAreaXPx),
            ...buildWidgetGuidesForAxis(
                interactive.otherWidgetsBounds,
                "x",
                WIDGET_SNAP_GAP
            ),
        ];
        const yGuides = [
            ...buildSceneGuides(sceneHeight),
            ...buildSafeAreaGuides(sceneHeight, safeAreaYPx),
            ...buildWidgetGuidesForAxis(
                interactive.otherWidgetsBounds,
                "y",
                WIDGET_SNAP_GAP
            ),
        ];

        const xResult = resolveAxisSnap(candidateLeft, scaledWidth, xGuides, thresholdScene);
        const yResult = resolveAxisSnap(candidateTop, scaledHeight, yGuides, thresholdScene);

        // box-start -> anchor-точка через ТЕКУЩИЙ (неизменный весь drag)
        // anchor - anchor сам никогда не пересчитывается здесь.
        setDraft({
            xVw: ((xResult.positionPx + frac.x * scaledWidth) / sceneWidth) * 100,
            yVh: ((yResult.positionPx + frac.y * scaledHeight) / sceneHeight) * 100,
        });

        interactive.onSnapGuidesChange?.({ x: xResult.guide, y: yResult.guide });
    };

    // Финальная позиция коммитится в state редактора здесь, на pointerup -
    // временный drag-offset (draft) сбрасывается сразу же, а не остаётся
    // "источником истины" поверх layout.
    const endDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
        if (!interactive) return;
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
        }
        if (draft) {
            interactive.onCommitPosition(draft.xVw, draft.yVh);
        }
        interactive.onSnapGuidesChange?.({ x: null, y: null });
        dragStartRef.current = null;
        setIsDragging(false);
        setDraft(null);
    };

    return (
        <div
            style={{
                position: "absolute",
                left: wrapperLeft,
                top: wrapperTop,
                cursor: interactive ? (isDragging ? "grabbing" : "grab") : undefined,
                touchAction: interactive ? "none" : undefined,
                userSelect: isDragging ? "none" : undefined,
            }}
            onPointerDown={handlePointerDown}
            onPointerMove={updateDrag}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
        >
            <div
                ref={contentRef}
                style={{
                    display: "inline-block",
                    transform: `scale(${layout.scale})`,
                    transformOrigin: "top left",
                }}
            >
                {children}
            </div>
        </div>
    );
};
