import { DEFAULT_OVERLAY_LAYOUT } from "./default-layout";
import type {
    CameraZone,
    MinimapCoverSettings,
    OverlayLayout,
    OverlayLayoutWidgets,
    OverlaySceneLayout,
} from "./types";

const asRecord = (value: unknown): Record<string, unknown> | null =>
    typeof value === "object" && value !== null && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null;

const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const normalizeWidgets = (
    value: unknown,
    fallback: OverlayLayoutWidgets
): OverlayLayoutWidgets => {
    const raw = asRecord(value);
    if (!raw) return clone(fallback);
    const result = clone(fallback);

    for (const id of ["session", "currentGame", "companionStatus"] as const) {
        const widget = asRecord(raw[id]);
        if (!widget) continue;
        result[id] = { ...result[id], ...widget };
    }
    const recentMatches = asRecord(raw.recentMatches);
    if (recentMatches) {
        result.recentMatches = {
            ...result.recentMatches,
            ...recentMatches,
            recentMatches: {
                ...result.recentMatches.recentMatches,
                ...(asRecord(recentMatches.recentMatches) ?? {}),
            },
        };
    }
    return result;
};

const normalizeCameraZone = (value: unknown, fallback: CameraZone): CameraZone => {
    const raw = asRecord(value);
    if (!raw) return { ...fallback };
    const legacy = (key: string, size: number) =>
        typeof raw[key] === "number" ? raw[key] * size / 100 : undefined;
    const number = (key: "x" | "y" | "width" | "height", legacyKey: string): number =>
        typeof raw[key] === "number"
            ? raw[key]
            : legacy(legacyKey, key === "x" || key === "width" ? 1920 : 1080)
                ?? fallback[key];
    const width = Math.min(Math.max(number("width", "widthPercent"), 80), 1920);
    const height = Math.min(Math.max(number("height", "heightPercent"), 80), 1080);
    return {
        enabled: typeof raw.enabled === "boolean" ? raw.enabled : fallback.enabled,
        anchor: typeof raw.anchor === "string" ? raw.anchor as CameraZone["anchor"] : "top-left",
        x: Math.min(Math.max(number("x", "xPercent"), 0), 1920 - width),
        y: Math.min(Math.max(number("y", "yPercent"), 0), 1080 - height),
        width,
        height,
    };
};

const normalizeMinimapCover = (value: unknown, fallback: MinimapCoverSettings): MinimapCoverSettings => {
    const raw = asRecord(value);
    if (!raw) return { ...fallback };
    return {
        enabled: typeof raw.enabled === "boolean" ? raw.enabled : fallback.enabled,
        preset: typeof raw.preset === "string" ? raw.preset as MinimapCoverSettings["preset"] : fallback.preset,
        anchor: typeof raw.anchor === "string" ? raw.anchor as MinimapCoverSettings["anchor"] : fallback.anchor,
        x: typeof raw.x === "number" ? raw.x : fallback.x,
        y: typeof raw.y === "number" ? raw.y : fallback.y,
        size: typeof raw.size === "number" ? Math.min(Math.max(raw.size, 120), 600) : fallback.size,
    };
};

const normalizeScene = (
    value: unknown,
    fallback: OverlaySceneLayout,
    legacyWidgets?: unknown
): OverlaySceneLayout => {
    const raw = asRecord(value);
    return {
        widgets: normalizeWidgets(raw?.widgets ?? legacyWidgets, fallback.widgets),
        cameraZone: normalizeCameraZone(raw?.cameraZone, fallback.cameraZone),
        minimapCover: normalizeMinimapCover(raw?.minimapCover, fallback.minimapCover),
    };
};

// Public overlay must never crash to a transparent frame because a cached API
// response or an old backend still serves layout v1.
export const normalizeOverlayLayout = (value: unknown): OverlayLayout => {
    const raw = asRecord(value);
    const scenes = asRecord(raw?.scenes);
    const aspectRatio = asRecord(raw?.aspectRatio);
    const fallback = DEFAULT_OVERLAY_LAYOUT;

    return {
        version: 2,
        aspectRatio:
            aspectRatio &&
            typeof aspectRatio.widthRatio === "number" &&
            typeof aspectRatio.heightRatio === "number"
                ? {
                      preset:
                          typeof aspectRatio.preset === "string"
                              ? (aspectRatio.preset as OverlayLayout["aspectRatio"]["preset"])
                              : fallback.aspectRatio.preset,
                      widthRatio: aspectRatio.widthRatio,
                      heightRatio: aspectRatio.heightRatio,
                  }
                : { ...fallback.aspectRatio },
        scenes: {
            gameplay: normalizeScene(
                scenes?.gameplay,
                fallback.scenes.gameplay,
                raw?.widgets
            ),
            draft: normalizeScene(scenes?.draft, fallback.scenes.draft),
        },
    };
};
