export const QUEUE_QUALITIES = ["low", "medium", "high"] as const;

export type QueueQuality = (typeof QUEUE_QUALITIES)[number];

export interface QueueQualityConfig {
    dprCap: number;
    fbmOctaves: 2 | 3 | 4;
    targetFps: 30 | 60;
    shaderQuality: number;
}

export const QUEUE_QUALITY_CONFIG: Record<QueueQuality, QueueQualityConfig> = {
    low: {
        dprCap: 0.85,
        fbmOctaves: 2,
        targetFps: 30,
        shaderQuality: 0,
    },
    medium: {
        dprCap: 1,
        fbmOctaves: 3,
        targetFps: 30,
        shaderQuality: 0.5,
    },
    high: {
        dprCap: 1.25,
        fbmOctaves: 4,
        targetFps: 60,
        shaderQuality: 1,
    },
};

export const DEFAULT_QUEUE_QUALITY: QueueQuality = "high";
export const DEFAULT_QUEUE_SEED = 123;

export const parseQuality = (value: unknown): QueueQuality =>
    typeof value === "string" &&
    QUEUE_QUALITIES.includes(value as QueueQuality)
        ? (value as QueueQuality)
        : DEFAULT_QUEUE_QUALITY;

export const parseSeed = (value: unknown): number => {
    if (typeof value !== "string" || value.trim() === "") {
        return DEFAULT_QUEUE_SEED;
    }

    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_QUEUE_SEED;

    return Math.min(Math.trunc(parsed), 999_999);
};

export interface QueueRenderSize {
    width: number;
    height: number;
    dpr: number;
}

export const calculateQueueRenderSize = (
    cssWidth: number,
    cssHeight: number,
    devicePixelRatio: number,
    quality: QueueQuality
): QueueRenderSize => {
    const safeWidth = Math.max(1, Math.floor(cssWidth));
    const safeHeight = Math.max(1, Math.floor(cssHeight));
    const safeDeviceDpr =
        Number.isFinite(devicePixelRatio) && devicePixelRatio > 0
            ? devicePixelRatio
            : 1;
    const { dprCap } = QUEUE_QUALITY_CONFIG[quality];
    const dpr =
        quality === "low"
            ? Math.min(Math.max(safeDeviceDpr, 0.75), dprCap)
            : Math.min(safeDeviceDpr, dprCap);

    return {
        width: Math.max(1, Math.floor(safeWidth * dpr)),
        height: Math.max(1, Math.floor(safeHeight * dpr)),
        dpr,
    };
};
