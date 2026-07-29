export const OVERLAY_WIDGET_IDS = [
    "session",
    "currentGame",
    "recentMatches",
    "companionStatus",
] as const;

export type OverlayWidgetId = (typeof OVERLAY_WIDGET_IDS)[number];

// Виртуальная сцена, в которой всегда рендерятся и редактор, и реальный
// overlay - оба масштабируются под неё целиком (см. OverlayCanvas), поэтому
// xVw/yVh (см. ниже) - это проценты ЭТОЙ сцены, а не CSS vw/vh окна браузера.
// Ширина сцены всегда фиксирована - высота больше не константа (см. задачу
// "aspect ratio сцены"), а вычисляется из aspectRatio ниже через
// computeSceneDimensions (lib/scene-dimensions.ts): sceneHeight =
// OVERLAY_BASE_WIDTH * heightRatio / widthRatio.
export const OVERLAY_BASE_WIDTH = 1920;

// preset - только для UI (какая кнопка подсвечена) - реальная геометрия
// всегда считается из widthRatio/heightRatio, поэтому "custom" не требует
// отдельной ветки где-либо кроме выбора пресета в редакторе.
export const OVERLAY_ASPECT_RATIO_PRESETS = [
    "16:9",
    "16:10",
    "21:9",
    "32:9",
    "4:3",
    "custom",
] as const;

export type OverlayAspectRatioPreset =
    (typeof OVERLAY_ASPECT_RATIO_PRESETS)[number];

export interface OverlayAspectRatio {
    preset: OverlayAspectRatioPreset;
    widthRatio: number;
    heightRatio: number;
}

// Отступ safe area от каждого края сцены, в процентах соответствующей оси -
// используется и для визуальных направляющих в редакторе, и как snap-цель
// (см. задачу, п.9). Не жёсткое ограничение - пользователь может подвинуть
// виджет ближе к краю, это только необязательная привязка.
export const SAFE_AREA_PERCENT = 3.5;

// Точка виджета, чья позиция задаётся xVw/yVh - "top-left" (поведение до
// anchors) означает, что в xVw/yVh сидит левый верхний угол виджета;
// остальные 8 - виджет растёт от выбранной точки в противоположную сторону,
// поэтому изменение его размера (scale, либо высота истории при добавлении
// строк) не сдвигает закреплённый край.
export const OVERLAY_ANCHORS = [
    "top-left",
    "top-center",
    "top-right",
    "center-left",
    "center",
    "center-right",
    "bottom-left",
    "bottom-center",
    "bottom-right",
] as const;

export type OverlayAnchor = (typeof OVERLAY_ANCHORS)[number];

export interface OverlayWidgetLayout {
    xVw: number;
    yVh: number;
    scale: number;
    visible: boolean;
    anchor: OverlayAnchor;
}

export const RECENT_MATCHES_LIMIT_MIN = 1;
export const RECENT_MATCHES_LIMIT_MAX = 20;

// growDirection раньше было отдельным пользовательским полем - теперь
// вычисляется из anchor виджета (см. lib/grow-direction.ts) и не хранится в
// layout JSON (см. задачу, п.3).
export interface RecentMatchesSettings {
    limit: number;
    direction: "newest-first" | "oldest-first";
    compact: boolean;
}

export interface RecentMatchesWidgetLayout extends OverlayWidgetLayout {
    recentMatches: RecentMatchesSettings;
}

export interface OverlayLayoutWidgets {
    session: OverlayWidgetLayout;
    currentGame: OverlayWidgetLayout;
    recentMatches: RecentMatchesWidgetLayout;
    companionStatus: OverlayWidgetLayout;
}

export type OverlayLayout = {
    version: 1;
    widgets: OverlayLayoutWidgets;
    aspectRatio: OverlayAspectRatio;
};
