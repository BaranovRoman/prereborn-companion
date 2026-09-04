import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { openDotaMatchProvider } from "../services/dota-match-provider.js";
import {
    getCachedPatchConstants,
    resolvePatchName,
    __resetOpenDotaPatchConstantsCacheForTests,
} from "../services/opendota-patch-constants-service.js";

// WK-148 - /constants/patch is NOT account-scoped: one cache entry for the
// whole backend, long TTL (patch list itself changes every few months).

beforeEach(() => {
    __resetOpenDotaPatchConstantsCacheForTests();
    vi.useFakeTimers();
});

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
});

describe("getCachedPatchConstants", () => {
    it("serves subsequent calls from cache without re-fetching", async () => {
        const spy = vi
            .spyOn(openDotaMatchProvider, "getPatchConstants")
            .mockResolvedValue({ status: "ok", patches: [{ id: 60, name: "7.41" }] });

        await getCachedPatchConstants();
        await getCachedPatchConstants();

        expect(spy).toHaveBeenCalledTimes(1);
    });

    it("refetches after the 24h TTL elapses", async () => {
        const spy = vi
            .spyOn(openDotaMatchProvider, "getPatchConstants")
            .mockResolvedValue({ status: "ok", patches: [] });

        await getCachedPatchConstants();
        vi.advanceTimersByTime(24 * 60 * 60_000 + 1);
        await getCachedPatchConstants();

        expect(spy).toHaveBeenCalledTimes(2);
    });

    it("falls back to the last known list on a failed refresh instead of going empty", async () => {
        const spy = vi
            .spyOn(openDotaMatchProvider, "getPatchConstants")
            .mockResolvedValueOnce({ status: "ok", patches: [{ id: 60, name: "7.41" }] });

        await getCachedPatchConstants();
        spy.mockResolvedValueOnce({ status: "unavailable" });
        vi.advanceTimersByTime(24 * 60 * 60_000 + 1);
        const result = await getCachedPatchConstants();

        expect(result).toEqual([{ id: 60, name: "7.41" }]);
    });
});

describe("resolvePatchName", () => {
    it("maps a known patch id to its name", () => {
        expect(resolvePatchName(60, [{ id: 60, name: "7.41" }])).toBe("7.41");
    });

    it("returns null (never guesses) for an unmapped patch id", () => {
        expect(resolvePatchName(999, [{ id: 60, name: "7.41" }])).toBeNull();
    });
});
