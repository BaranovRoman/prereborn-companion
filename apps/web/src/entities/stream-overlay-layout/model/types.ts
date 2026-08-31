export const OVERLAY_WIDGET_IDS = [
    "session",
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
    width: number;
    height: number;
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
    source: "current-stream" | "recent-matches";
    direction: "newest-first" | "oldest-first";
    compact: boolean;
}

export interface RecentMatchesWidgetLayout extends OverlayWidgetLayout {
    recentMatches: RecentMatchesSettings;
}

export interface OverlayLayoutWidgets {
    session: OverlayWidgetLayout;
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
    anchor: OverlayAnchor;
    x: number;
    y: number;
    width: number;
    height: number;
}

export const MINIMAP_COVER_PRESETS = ["clean", "random-a", "random-b", "random-dense", "interactive"] as const;
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

// WK-69 follow-up (visual review): Cinematic Draft (`off`'s old renderer)
// and Fake Draft (`substitute`) were both removed - Cinematic Draft never had
// enough real GSI data for a full 5x5, and Fake Draft's carousel didn't hold
// up on visual review and added real media/performance cost for a mode
// nobody wanted. `off` is now a literal no-op: no renderer, no hero
// cards/video, nothing drawn over the real Dota UI. `substitute` is gone as
// a selectable value; normalizeOverlayLayout still recognizes the legacy
// string on read and fails closed to "cover" (see normalize-layout.ts) so an
// old persisted layout can never silently lose its protection.
export const DRAFT_PROTECTION_MODES = ["off", "cover"] as const;
export type DraftProtectionMode = (typeof DRAFT_PROTECTION_MODES)[number];

// Single source of truth for user-facing mode labels - the editor's mode
// switcher (see overlay-editor/index.tsx) derives its options from this map
// instead of hardcoding a second `{label, value}` array, so TypeScript flags
// a missing label the moment DRAFT_PROTECTION_MODES grows.
export const DRAFT_PROTECTION_MODE_LABELS: Record<DraftProtectionMode, string> = {
    off: "Без защиты",
    cover: "Заглушка",
};

// Reserved identifier for a future "Фотореализм" mode: a decoy Dota draft UI
// assembled from user-prepared template screenshots (transparent areas for
// safe nicknames/hero video) + an explicit user-configured safe fake-hero
// pool. Deliberately NOT part of DRAFT_PROTECTION_MODES yet - it has no
// renderer, and adding it to the persisted/validated union would make it a
// selectable-but-broken value before templates/pool config exist.
//
// Safety rule for whoever implements it: fake content must come ONLY from
// the explicit safe fake pool, prepared templates, and an independent
// randomization/state machine - it must NEVER be derived from or correlated
// with the real hero/pick/ban (no "real pick -> similar-looking fake pick").
// The removed Fake Draft mode observed this same rule for one field only
// (excluding the player's own real hero id from its fake pool) - see
// docs/draft-gsi-contract.md for why even that is no longer needed now that
// `off` and `substitute` are both gone.
//
// To implement: add the value to DRAFT_PROTECTION_MODES, a label above, a
// renderer entry in draft-protection-layer.tsx's registry, and an option in
// the editor's Segmented control (already derived from the two maps above,
// so no hardcoded options array to update). The union type will then force
// every exhaustive switch to be revisited.
export const RESERVED_FUTURE_DRAFT_PROTECTION_MODE = "photorealism" as const;

// Свободный статичный текст на Draft Protected экране (mode "cover" -
// "Заглушка", см. задачу WK-86) - позиционируется через ту же
// AnchoredWidget-модель, что и остальные виджеты (xVw/yVh/scale/anchor),
// только с добавленным content. `scale` здесь и есть регулировка размера
// шрифта (UI подписывает его "Размер шрифта" для этого элемента) - решение
// не заводить отдельное поле fontSize, а переиспользовать уже существующий
// scale-механизм AnchoredWidget (см. задачу: "без отдельного конструктора
// типографики"). Полностью независим от DVD-логотипа (BouncingLogo) - тот
// не читает layout вообще.
export interface DraftProtectionTextSettings extends OverlayWidgetLayout {
    content: string;
}

// Разумный максимум, чтобы длинный текст не мог сломать композицию заглушки
// (см. задачу) - текст всегда однострочный (см. draft-protection-text.tsx).
export const DRAFT_PROTECTION_TEXT_MAX_LENGTH = 80;

export interface DraftProtectionSettings {
    mode: DraftProtectionMode;
    text: DraftProtectionTextSettings;
}

export type OverlayLayout = {
    version: 5;
    scenes: Record<ConfigurableBroadcastSceneId, OverlaySceneLayout>;
    aspectRatio: OverlayAspectRatio;
    draftProtection: DraftProtectionSettings;
};
