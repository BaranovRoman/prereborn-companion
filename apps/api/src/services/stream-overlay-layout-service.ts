import { z } from "zod";
import { pool } from "../db/client.js";

export const OVERLAY_WIDGET_IDS = [
    "session",
    "currentGame",
    "recentMatches",
    "companionStatus",
] as const;

export type OverlayWidgetId = (typeof OVERLAY_WIDGET_IDS)[number];

// Точка виджета, чья позиция задаётся xVw/yVh - "top-left" означает
// поведение до появления anchors (левый верхний угол виджета сидит в
// xVw/yVh), остальные 8 - виджет растёт от выбранной точки в противоположную
// сторону, поэтому изменение его размера (scale, либо высота истории матчей
// при добавлении строк) не сдвигает закреплённый край.
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
export const OVERLAY_CORNERS = ["top-left", "top-right", "bottom-left", "bottom-right"] as const;
export type OverlayCorner = (typeof OVERLAY_CORNERS)[number];

export interface OverlayWidgetLayout {
    xVw: number;
    yVh: number;
    scale: number;
    visible: boolean;
    anchor: OverlayAnchor;
}

export const RECENT_MATCHES_LIMIT_MIN = 1;
export const RECENT_MATCHES_LIMIT_MAX = 20;

// Виртуальная сцена больше не всегда 1920x1080 (см. задачу "aspect ratio
// сцены") - ширина остаётся константой (OVERLAY_BASE_WIDTH,
// entities/stream-overlay-layout в frontend), высота вычисляется из
// aspectRatio. preset - только для UI (какая кнопка подсвечена), реальная
// геометрия всегда считается из widthRatio/heightRatio - "custom" просто
// единственный preset без готовой пары чисел.
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

export const DEFAULT_OVERLAY_ASPECT_RATIO: OverlayAspectRatio = {
    preset: "16:9",
    widthRatio: 16,
    heightRatio: 9,
    width: 1920,
    height: 1080,
};

// growDirection раньше было отдельным пользовательским полем - теперь
// вычисляется из anchor виджета (top-* растёт вниз, bottom-* растёт вверх,
// center-* вниз как самый предсказуемый вариант), поэтому в layout JSON
// больше не хранится (см. задачу, п.3). Старое сохранённое значение просто
// не описано в схеме ниже - buildRecentMatchesSettingsSchema его игнорирует.
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
    currentGame: OverlayWidgetLayout;
    recentMatches: RecentMatchesWidgetLayout;
    companionStatus: OverlayWidgetLayout;
}

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

// Kept in sync by hand with apps/web/.../stream-overlay-layout/model/types.ts
// (no shared types package). WK-69 follow-up: "substitute" (Fake Draft) was
// removed as a selectable mode - validation below (z.enum(...).catch("cover"))
// already fails closed to "cover" for any value outside this tuple, so a
// persisted "substitute" layout is migrated automatically on read, no extra
// migration code needed. A future "photorealism" mode is reserved on the web
// side (RESERVED_FUTURE_DRAFT_PROTECTION_MODE) but intentionally not added to
// this tuple yet - see that file for the safety rule and the addition
// order. Validation below (z.enum(DRAFT_PROTECTION_MODES)) already reads
// this tuple generically, so extending it here is the only change this file
// needs once a renderer exists.
export const DRAFT_PROTECTION_MODES = ["off", "cover"] as const;
export type DraftProtectionMode = (typeof DRAFT_PROTECTION_MODES)[number];
export interface DraftProtectionSettings {
    mode: DraftProtectionMode;
}

export type OverlayLayout = {
    version: 4;
    scenes: {
        draft: OverlaySceneLayout;
        gameplay: OverlaySceneLayout;
    };
    aspectRatio: OverlayAspectRatio;
    draftProtection: DraftProtectionSettings;
};

// Раскладка по умолчанию воспроизводит сегодняшний вид (всё сложено в
// левом верхнем углу) плюс новый companionStatus-виджет, которого раньше в
// HUD вообще не было (только в debug-панели) - размещён внизу слева, чтобы
// не спорить за место с остальными тремя. anchor "top-left" везде - тот же
// смысл, который xVw/yVh уже имели ДО появления anchors: намеренно не
// переезжаем на более "красивые" bottom-* дефолты, чтобы не переизобретать
// сегодняшний внешний вид заодно с этой задачей.
const defaultGameplayWidgets: OverlayLayoutWidgets = {
        session: { xVw: 3, yVh: 4, scale: 1, visible: true, anchor: "top-left" },
        currentGame: {
            xVw: 3,
            yVh: 12,
            scale: 1,
            visible: true,
            anchor: "top-left",
        },
        recentMatches: {
            xVw: 3,
            yVh: 22,
            scale: 1,
            visible: true,
            anchor: "top-left",
            recentMatches: {
                limit: 5,
                source: "current-stream",
                direction: "newest-first",
                compact: true,
            },
        },
        companionStatus: {
            xVw: 3,
            yVh: 92,
            scale: 1,
            visible: true,
            anchor: "top-left",
        },
};

export const DEFAULT_OVERLAY_LAYOUT: OverlayLayout = {
    version: 4,
    scenes: {
        gameplay: {
            widgets: defaultGameplayWidgets,
            cameraZone: {
                enabled: true,
                anchor: "bottom-right",
                x: 1860,
                y: 1013,
                width: 400,
                height: 300,
            },
            minimapCover: { enabled: true, preset: "random-a", anchor: "bottom-left", x: 0, y: 0, size: 282 },
        },
        draft: {
            widgets: {
                ...defaultGameplayWidgets,
                currentGame: { ...defaultGameplayWidgets.currentGame, visible: false },
                recentMatches: {
                    ...defaultGameplayWidgets.recentMatches,
                    xVw: 3,
                    yVh: 70,
                    recentMatches: { ...defaultGameplayWidgets.recentMatches.recentMatches },
                },
            },
            cameraZone: {
                enabled: true,
                anchor: "bottom-left",
                x: 60,
                y: 1013,
                width: 400,
                height: 300,
            },
            minimapCover: { enabled: false, preset: "random-a", anchor: "bottom-left", x: 0, y: 0, size: 282 },
        },
    },
    aspectRatio: DEFAULT_OVERLAY_ASPECT_RATIO,
    draftProtection: { mode: "cover" },
};

export class InvalidOverlayLayoutError extends Error {
    constructor(message: string) {
        super(message);
    }
}

const clamp = (value: number, min: number, max: number): number =>
    Math.min(Math.max(value, min), max);

const anchorEnum = z.enum(OVERLAY_ANCHORS);
// Целое число 1-20 (см. задачу, п.4/п.12) - старые union-значения (3/5/8/10)
// парсятся как обычные числа, ничего специально мигрировать не нужно.
const limitSchema = z
    .number()
    .int()
    .min(RECENT_MATCHES_LIMIT_MIN)
    .max(RECENT_MATCHES_LIMIT_MAX);

// Каждое поле валидируется и при некорректном значении откатывается на своё
// ЛИЧНОЕ дефолтное значение через .catch(...), а не всё целиком - именно
// так старый сохранённый layout (без anchor/recentMatches, до этой задачи)
// нормализуется без потери xVw/yVh: отсутствующий/некорректный anchor
// становится "top-left" (см. задачу, п.11 - миграция без потери позиции),
// а реальные сохранённые координаты остаются как есть.
const buildWidgetSchema = (fallback: OverlayWidgetLayout) =>
    z
        .object({
            xVw: z.number().catch(fallback.xVw),
            yVh: z.number().catch(fallback.yVh),
            scale: z.number().catch(fallback.scale),
            visible: z.boolean().catch(fallback.visible),
            anchor: anchorEnum.catch(fallback.anchor),
        })
        .catch(fallback);

// growDirection намеренно не описан здесь - если он присутствует в старом
// сохранённом JSON, zod.object() (без .passthrough()) просто не включает
// незнакомые/более неактуальные поля в результат, поэтому он молча
// отбрасывается при следующей нормализации/сохранении (см. задачу, п.3/п.12).
const buildRecentMatchesSettingsSchema = (fallback: RecentMatchesSettings) =>
    z
        .object({
            limit: limitSchema.catch(fallback.limit),
            source: z.enum(["current-stream", "recent-matches"]).catch(fallback.source),
            direction: z
                .enum(["newest-first", "oldest-first"])
                .catch(fallback.direction),
            compact: z.boolean().catch(fallback.compact),
        })
        .catch(fallback);

const buildRecentMatchesWidgetSchema = (fallback: RecentMatchesWidgetLayout) =>
    z
        .object({
            xVw: z.number().catch(fallback.xVw),
            yVh: z.number().catch(fallback.yVh),
            scale: z.number().catch(fallback.scale),
            visible: z.boolean().catch(fallback.visible),
            anchor: anchorEnum.catch(fallback.anchor),
            recentMatches: buildRecentMatchesSettingsSchema(
                fallback.recentMatches
            ).catch(fallback.recentMatches),
        })
        .catch(fallback);

const layoutBodySchema = z.object({
    version: z.number().optional(),
    widgets: z.record(z.string(), z.unknown()).optional(),
    scenes: z.record(z.string(), z.unknown()).optional(),
    aspectRatio: z.unknown().optional(),
    draftProtection: z.unknown().optional(),
});

const aspectRatioPresetEnum = z.enum(OVERLAY_ASPECT_RATIO_PRESETS);
// Только положительные числа (см. задачу - "не пиксели, а две части
// соотношения") - каждое поле откатывается на дефолт независимо, тем же
// паттерном .catch(), что и buildWidgetSchema выше.
const ratioPartSchema = z.number().positive();

const buildAspectRatioSchema = (fallback: OverlayAspectRatio) =>
    z
        .object({
            preset: aspectRatioPresetEnum.catch(fallback.preset),
            widthRatio: ratioPartSchema.catch(fallback.widthRatio),
            heightRatio: ratioPartSchema.catch(fallback.heightRatio),
            width: z.number().int().min(640).max(7680).catch(fallback.width),
            height: z.number().int().min(360).max(4320).catch(fallback.height),
        })
        .catch(fallback);

const clampWidget = (widget: OverlayWidgetLayout): OverlayWidgetLayout => ({
    ...widget,
    xVw: clamp(widget.xVw, 0, 100),
    yVh: clamp(widget.yVh, 0, 100),
    scale: clamp(widget.scale, 0.5, 2),
});

// Валидирует произвольный JSON от клиента. Проходим только по 4 известным
// widget id - значит неизвестные ключи (например опечатка или устаревший
// id) автоматически никогда не попадают в результат, без явного списка
// "запрещённых" id.
export const normalizeOverlayLayout = (input: unknown): OverlayLayout => {
    const parsed = layoutBodySchema.safeParse(input);
    if (!parsed.success) {
        throw new InvalidOverlayLayoutError("Invalid overlay layout shape");
    }

    const normalizeWidgets = (
        inputWidgets: unknown,
        defaults: OverlayLayoutWidgets
    ): OverlayLayoutWidgets => {
        const raw =
            typeof inputWidgets === "object" && inputWidgets !== null
                ? (inputWidgets as Record<string, unknown>)
                : {};

        const recentMatchesParsed = buildRecentMatchesWidgetSchema(
            defaults.recentMatches
        ).parse(raw.recentMatches);
        return {
            session: clampWidget(buildWidgetSchema(defaults.session).parse(raw.session)),
            currentGame: clampWidget(
                buildWidgetSchema(defaults.currentGame).parse(raw.currentGame)
            ),
            companionStatus: clampWidget(
                buildWidgetSchema(defaults.companionStatus).parse(raw.companionStatus)
            ),
            recentMatches: {
                ...clampWidget(recentMatchesParsed),
                recentMatches: recentMatchesParsed.recentMatches,
            },
        };
    };

    const normalizeCameraZone = (
        value: unknown,
        fallback: CameraZone,
        layoutVersion: number
    ): CameraZone => {
        if (typeof value !== "object" || value === null) return fallback;
        const raw = value as Record<string, unknown>;
        const fromPercent = (key: string, size: number): number | undefined =>
            typeof raw[key] === "number" ? (raw[key] as number) * size / 100 : undefined;
        const number = (key: string, legacyKey: string, fallbackValue: number) =>
            typeof raw[key] === "number"
                ? (raw[key] as number)
                : fromPercent(legacyKey, key === "x" || key === "width" ? 1920 : 1080)
                    ?? fallbackValue;
        const width = clamp(number("width", "widthPercent", fallback.width), 80, 1920);
        const height = clamp(number("height", "heightPercent", fallback.height), 80, 1080);
        const anchor = OVERLAY_ANCHORS.includes(raw.anchor as OverlayAnchor)
            ? raw.anchor as OverlayAnchor
            : "top-left";
        let x = clamp(number("x", "xPercent", fallback.x), 0, 1920);
        let y = clamp(number("y", "yPercent", fallback.y), 0, 1080);
        if (layoutVersion < 3 && typeof raw.anchor === "string") {
            if (anchor.endsWith("right")) x = 1920 - x;
            if (anchor.startsWith("bottom")) y = 1080 - y;
        }
        return {
            enabled: typeof raw.enabled === "boolean" ? raw.enabled : fallback.enabled,
            anchor,
            x,
            y,
            width,
            height,
        };
    };

    const normalizeMinimapCover = (
        value: unknown,
        fallback: MinimapCoverSettings
    ): MinimapCoverSettings => {
        if (typeof value !== "object" || value === null) return fallback;
        const raw = value as Record<string, unknown>;
        const legacyPresets: Record<string, MinimapCoverPreset> = {
            "balanced-a": "random-a", "balanced-b": "random-b",
            "dense-a": "random-dense", "dense-b": "random-dense", "dense-c": "random-dense",
        };
        const preset = typeof raw.preset === "string" && legacyPresets[raw.preset]
            ? legacyPresets[raw.preset]
            : MINIMAP_COVER_PRESETS.includes(raw.preset as MinimapCoverPreset)
                ? raw.preset as MinimapCoverPreset
                : fallback.preset;
        return {
            enabled: typeof raw.enabled === "boolean" ? raw.enabled : fallback.enabled,
            preset,
            anchor: OVERLAY_CORNERS.includes(raw.anchor as OverlayCorner)
                ? raw.anchor as OverlayCorner
                : fallback.anchor,
            x: clamp(typeof raw.x === "number" ? raw.x : fallback.x, 0, 1920),
            y: clamp(typeof raw.y === "number" ? raw.y : fallback.y, 0, 1080),
            size: clamp(typeof raw.size === "number" ? raw.size : fallback.size, 120, 600),
        };
    };

    const rawScenes = parsed.data.scenes ?? {};
    const layoutVersion = typeof parsed.data.version === "number" ? parsed.data.version : 1;
    const rawGameplay = rawScenes.gameplay as Record<string, unknown> | undefined;
    const rawDraft = rawScenes.draft as Record<string, unknown> | undefined;
    // v1 stored a single widgets collection. Preserve it as the gameplay scene.
    const legacyWidgets = parsed.data.widgets;
    const gameplayDefaults = DEFAULT_OVERLAY_LAYOUT.scenes.gameplay;
    const draftDefaults = DEFAULT_OVERLAY_LAYOUT.scenes.draft;
    const aspectRatio = buildAspectRatioSchema(
        DEFAULT_OVERLAY_ASPECT_RATIO
    ).parse(parsed.data.aspectRatio);

    return {
        version: 4,
        scenes: {
            gameplay: {
                widgets: normalizeWidgets(
                    rawGameplay?.widgets ?? legacyWidgets,
                    gameplayDefaults.widgets
                ),
                cameraZone: normalizeCameraZone(
                    rawGameplay?.cameraZone,
                    gameplayDefaults.cameraZone,
                    layoutVersion
                ),
                minimapCover: normalizeMinimapCover(rawGameplay?.minimapCover, gameplayDefaults.minimapCover),
            },
            draft: {
                widgets: normalizeWidgets(rawDraft?.widgets, draftDefaults.widgets),
                cameraZone: normalizeCameraZone(
                    rawDraft?.cameraZone,
                    draftDefaults.cameraZone,
                    layoutVersion
                ),
                minimapCover: normalizeMinimapCover(rawDraft?.minimapCover, draftDefaults.minimapCover),
            },
        },
        aspectRatio,
        draftProtection: {
            mode: z.enum(DRAFT_PROTECTION_MODES).catch("cover").parse(
                typeof parsed.data.draftProtection === "object" &&
                    parsed.data.draftProtection !== null
                    ? (parsed.data.draftProtection as Record<string, unknown>).mode
                    : undefined
            ),
        },
    };
};

export const getOverlayLayout = async (
    streamUserId: string
): Promise<OverlayLayout> => {
    const result = await pool.query<{ layout: OverlayLayout }>(
        `SELECT layout FROM stream_overlay_settings WHERE stream_user_id = $1`,
        [streamUserId]
    );
    if (!result.rows[0]) return DEFAULT_OVERLAY_LAYOUT;
    return normalizeOverlayLayout(result.rows[0].layout);
};

export const saveOverlayLayout = async (
    streamUserId: string,
    input: unknown
): Promise<OverlayLayout> => {
    const layout = normalizeOverlayLayout(input);
    await pool.query(
        `INSERT INTO stream_overlay_settings (stream_user_id, layout_version, layout)
         VALUES ($1, $2, $3)
         ON CONFLICT (stream_user_id)
         DO UPDATE SET layout = $3, layout_version = $2, updated_at = CURRENT_TIMESTAMP`,
        [streamUserId, layout.version, JSON.stringify(layout)]
    );
    return layout;
};
