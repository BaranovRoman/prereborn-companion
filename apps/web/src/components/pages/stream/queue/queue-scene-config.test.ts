import { describe, expect, it } from "vitest";
import {
    calculateQueueRenderSize,
    DEFAULT_QUEUE_SEED,
    parseQuality,
    parseSeed,
} from "./queue-scene-config";

describe("queue scene config", () => {
    it("parses quality and defaults unknown values to high", () => {
        expect(parseQuality("low")).toBe("low");
        expect(parseQuality("medium")).toBe("medium");
        expect(parseQuality("high")).toBe("high");
        expect(parseQuality("ultra")).toBe("high");
        expect(parseQuality(undefined)).toBe("high");
    });

    it("parses a stable non-negative seed", () => {
        expect(parseSeed("123")).toBe(123);
        expect(parseSeed("123.9")).toBe(123);
        expect(parseSeed("9999999")).toBe(999_999);
        expect(parseSeed("-1")).toBe(DEFAULT_QUEUE_SEED);
        expect(parseSeed("not-a-number")).toBe(DEFAULT_QUEUE_SEED);
    });

    it("caps render DPR per quality", () => {
        expect(calculateQueueRenderSize(1920, 1080, 2, "low")).toEqual({
            width: 1632,
            height: 918,
            dpr: 0.85,
        });
        expect(calculateQueueRenderSize(1920, 1080, 2, "medium")).toEqual({
            width: 1920,
            height: 1080,
            dpr: 1,
        });
        expect(calculateQueueRenderSize(1920, 1080, 2, "high")).toEqual({
            width: 2400,
            height: 1350,
            dpr: 1.25,
        });
    });

    it("sanitizes invalid dimensions and DPR", () => {
        expect(calculateQueueRenderSize(0, -10, Number.NaN, "medium")).toEqual({
            width: 1,
            height: 1,
            dpr: 1,
        });
    });
});
