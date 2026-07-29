// Ось-независимая привязка одной координаты (x ИЛИ y) при drag в редакторе
// (см. AnchoredWidget). В отличие от более ранней версии, snapping здесь
// НИКОГДА не меняет anchor - он только подравнивает позицию (см. задачу,
// п.1: "Drag и snapping изменяют только координаты xVw/yVh"). Anchor
// перетаскиваемого виджета фиксируется в начале жеста и остаётся
// неизменным всё время drag - resolveAxisSnap просто возвращает итоговую
// позицию НАЧАЛА бокса (box-start), а не anchor-точку; перевод box-start
// обратно в anchor-точку (через anchorFraction) делает вызывающий код
// (anchored-widget.tsx), которому известен фиксированный anchor.
export type SnapGuideKind = "scene" | "safe-area" | "widget-align" | "widget-gap";

export interface SnapGuide {
    // Целевое scene-px значение - и то, чему должна равняться feature
    // перетаскиваемого виджета, и то, где рисуется направляющая линия.
    value: number;
    // Какая часть перетаскиваемого виджета должна совпасть с value:
    // 0 = start (left/top), 0.5 = center, 1 = end (right/bottom).
    feature: 0 | 0.5 | 1;
    kind: SnapGuideKind;
    // Только для kind="widget-gap" - показывается рядом с направляющей.
    gapLabel?: number;
}

export interface AxisSnapOutcome {
    positionPx: number; // итоговое положение НАЧАЛА бокса (box-start)
    guide: SnapGuide | null;
}

const FEATURES: Array<0 | 0.5 | 1> = [0, 0.5, 1];

export const buildSceneGuides = (sceneSize: number): SnapGuide[] =>
    [0, sceneSize / 2, sceneSize].flatMap((value) =>
        FEATURES.map((feature) => ({ value, feature, kind: "scene" as const }))
    );

export const buildSafeAreaGuides = (
    sceneSize: number,
    safeAreaOffset: number
): SnapGuide[] =>
    [safeAreaOffset, sceneSize - safeAreaOffset].flatMap((value) =>
        FEATURES.map((feature) => ({ value, feature, kind: "safe-area" as const }))
    );

export interface OtherWidgetBounds {
    left: number;
    top: number;
    width: number;
    height: number;
}

// Направляющие от ДРУГИХ (не перетаскиваемых, видимых) виджетов - 3 на
// выравнивание (left-left/centerX-centerX/right-right, аналогично по Y) + 2
// на стандартный отступ (см. задачу, п.6: "справа/слева/выше/ниже" другого
// виджета на WIDGET_SNAP_GAP).
export const buildWidgetGuidesForAxis = (
    others: OtherWidgetBounds[],
    axis: "x" | "y",
    gap: number
): SnapGuide[] => {
    const guides: SnapGuide[] = [];
    for (const other of others) {
        const start = axis === "x" ? other.left : other.top;
        const size = axis === "x" ? other.width : other.height;
        const end = start + size;
        const center = start + size / 2;

        guides.push({ value: start, feature: 0, kind: "widget-align" });
        guides.push({ value: center, feature: 0.5, kind: "widget-align" });
        guides.push({ value: end, feature: 1, kind: "widget-align" });

        // Двигаемый виджет ПОСЛЕ other (правее/ниже) -> его start = other.end + gap.
        guides.push({
            value: end + gap,
            feature: 0,
            kind: "widget-gap",
            gapLabel: gap,
        });
        // Двигаемый виджет ПЕРЕД other (левее/выше) -> его end = other.start - gap.
        guides.push({
            value: start - gap,
            feature: 1,
            kind: "widget-gap",
            gapLabel: gap,
        });
    }
    return guides;
};

// Находит ближайшую (в пределах threshold) направляющую среди ВСЕХ
// переданных кандидатов (сцена + safe area + другие виджеты, уже собранные
// вызывающим кодом) и пересчитывает box-start так, чтобы совпавшая feature
// легла ровно на неё. Без совпадений - позиция не меняется (свободный drag).
export const resolveAxisSnap = (
    rawBoxStart: number,
    scaledSize: number,
    guides: SnapGuide[],
    thresholdScene: number
): AxisSnapOutcome => {
    let best: { distance: number; guide: SnapGuide } | null = null;
    for (const guide of guides) {
        const myFeatureValue = rawBoxStart + guide.feature * scaledSize;
        const distance = Math.abs(myFeatureValue - guide.value);
        if (distance <= thresholdScene && (!best || distance < best.distance)) {
            best = { distance, guide };
        }
    }

    if (!best) {
        return { positionPx: rawBoxStart, guide: null };
    }

    return {
        positionPx: best.guide.value - best.guide.feature * scaledSize,
        guide: best.guide,
    };
};
