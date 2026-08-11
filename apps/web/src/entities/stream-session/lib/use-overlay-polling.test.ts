import { describe, expect, it } from "vitest";
import type { OverlayData } from "../model/types";
import { preserveOverlayDataAsStale } from "./use-overlay-polling";

describe("preserveOverlayDataAsStale", () => {
    it("keeps the last complete payload while failing closed", () => {
        const payload = { map: { game_state: "DOTA_GAMERULES_STATE_GAME_IN_PROGRESS" } };
        const layout = { version: 5 };
        const current = {
            companion: { isOnline: true, payload },
            layout,
        } as unknown as OverlayData;

        const stale = preserveOverlayDataAsStale(current);

        expect(stale).not.toBeNull();
        expect(stale?.companion.isOnline).toBe(false);
        expect(stale?.companion.payload).toBe(payload);
        expect(stale?.layout).toBe(layout);
    });

    it("does not invent data when no valid payload exists", () => {
        expect(preserveOverlayDataAsStale(null)).toBeNull();
    });
});
