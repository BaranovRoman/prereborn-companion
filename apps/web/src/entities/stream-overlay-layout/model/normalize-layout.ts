import { DEFAULT_OVERLAY_LAYOUT } from "./default-layout";
import { DRAFT_PROTECTION_MODES, RECENT_MATCHES_LIMIT_MAX, RECENT_MATCHES_LIMIT_MIN } from "./types";
import type {
    CameraZone,
    DraftProtectionMode,
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

// Generic membership check against DRAFT_PROTECTION_MODES rather than a
// hardcoded `=== "off" || === "cover"` whitelist - a mode added to (or
// removed from, e.g. WK-69's "substitute"/Fake Draft removal) the tuple in
// types.ts is picked up here automatically. This is also the fail-closed
// migration path for that removal: a persisted "substitute" value is no
// longer in DRAFT_PROTECTION_MODES, so it falls back to "cover" below
// exactly like any other invalid value - never to "off".
const isDraftProtectionMode = (value: unknown): value is DraftProtectionMode =>
    (DRAFT_PROTECTION_MODES as readonly string[]).includes(value as string);

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
        const settings = asRecord(recentMatches.recentMatches);
        const rawLimit = settings?.limit;
        const limit =
            typeof rawLimit === "number" &&
            Number.isInteger(rawLimit) &&
            rawLimit >= RECENT_MATCHES_LIMIT_MIN &&
            rawLimit <= RECENT_MATCHES_LIMIT_MAX
                ? rawLimit
                : result.recentMatches.recentMatches.limit;
        const source =
            settings?.source === "recent-matches"
                ? "recent-matches"
                : "current-stream";
        result.recentMatches = {
            ...result.recentMatches,
            ...recentMatches,
            recentMatches: {
                ...result.recentMatches.recentMatches,
                ...(settings ?? {}),
                limit,
                source,
            },
        };
    }
    return result;
};

const normalizeCameraZone = (value: unknown, fallback: CameraZone, layoutVersion: number): CameraZone => {
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
    const anchor = typeof raw.anchor === "string" ? raw.anchor as CameraZone["anchor"] : "top-left";
    let x = Math.min(Math.max(number("x", "xPercent"), 0), 1920);
    let y = Math.min(Math.max(number("y", "yPercent"), 0), 1080);
    // v2 stored distances from the selected edge. v3 follows OBS: X/Y are
    // coordinates of the selected alignment point from the scene's top-left.
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

const normalizeMinimapCover = (value: unknown, fallback: MinimapCoverSettings): MinimapCoverSettings => {
    const raw = asRecord(value);
    if (!raw) return { ...fallback };
    const legacyPresets: Record<string, MinimapCoverSettings["preset"]> = {
        "balanced-a": "random-a", "balanced-b": "random-b",
        "dense-a": "random-dense", "dense-b": "random-dense", "dense-c": "random-dense",
    };
    const preset = typeof raw.preset === "string"
        ? legacyPresets[raw.preset] ?? (["clean", "random-a", "random-b", "random-dense", "interactive"].includes(raw.preset) ? raw.preset as MinimapCoverSettings["preset"] : fallback.preset)
        : fallback.preset;
    return {
        enabled: typeof raw.enabled === "boolean" ? raw.enabled : fallback.enabled,
        preset,
        anchor: typeof raw.anchor === "string" ? raw.anchor as MinimapCoverSettings["anchor"] : fallback.anchor,
        x: typeof raw.x === "number" ? raw.x : fallback.x,
        y: typeof raw.y === "number" ? raw.y : fallback.y,
        size: typeof raw.size === "number" ? Math.min(Math.max(raw.size, 120), 600) : fallback.size,
    };
};

const normalizeScene = (
    value: unknown,
    fallback: OverlaySceneLayout,
    layoutVersion: number,
    legacyWidgets?: unknown
): OverlaySceneLayout => {
    const raw = asRecord(value);
    return {
        widgets: normalizeWidgets(raw?.widgets ?? legacyWidgets, fallback.widgets),
        cameraZone: normalizeCameraZone(raw?.cameraZone, fallback.cameraZone, layoutVersion),
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
    const layoutVersion = typeof raw?.version === "number" ? raw.version : 1;

    return {
        version: 4,
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
                      width: typeof aspectRatio.width === "number" ? aspectRatio.width : fallback.aspectRatio.width,
                      height: typeof aspectRatio.height === "number" ? aspectRatio.height : fallback.aspectRatio.height,
                  }
                : { ...fallback.aspectRatio },
        scenes: {
            gameplay: normalizeScene(
                scenes?.gameplay,
                fallback.scenes.gameplay,
                layoutVersion,
                raw?.widgets
            ),
            draft: normalizeScene(scenes?.draft, fallback.scenes.draft, layoutVersion),
        },
        draftProtection: {
            mode: isDraftProtectionMode(asRecord(raw?.draftProtection)?.mode)
                ? (asRecord(raw?.draftProtection)?.mode as DraftProtectionMode)
                : "cover",
        },
    };
};
