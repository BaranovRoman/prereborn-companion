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

export const BROADCAST_SCENE_IDS = ["betweenMatches", "draft", "gameplay"] as const;
export type BroadcastSceneId = (typeof BROADCAST_SCENE_IDS)[number];
export type ConfigurableBroadcastSceneId = Exclude<BroadcastSceneId, "betweenMatches">;

export const OVERLAY_CORNERS = ["top-left", "top-right", "bottom-left", "bottom-right"] as const;
export type OverlayCorner = (typeof OVERLAY_CORNERS)[number];

// Camera is owned and positioned by OBS. This rectangle is editor-only and
// lets the streamer reserve the same part of the canvas in our layouts.
export interface CameraZone {
    enabled: boolean;
    anchor: OverlayCorner;
    x: number;
    y: number;
    width: number;
    height: number;
}

export const MINIMAP_COVER_PRESETS = ["balanced-a", "balanced-b", "dense-a", "dense-b", "dense-c"] as const;
export type MinimapCoverPreset = (typeof MINIMAP_COVER_PRESETS)[number];

export interface MinimapCoverSettings {
    enabled: boolean;
    preset: MinimapCoverPreset;
    anchor: OverlayCorner;
    x: number;
    y: number;
    size: number;
}

export interface OverlaySceneLayout {
    widgets: OverlayLayoutWidgets;
    cameraZone: CameraZone;
    minimapCover: MinimapCoverSettings;
}

export type OverlayLayout = {
    version: 2;
    scenes: Record<ConfigurableBroadcastSceneId, OverlaySceneLayout>;
    aspectRatio: OverlayAspectRatio;
};
