import { describe, expect, it } from "vitest";
import { getDraftSignals } from "./get-draft-signals";

describe("getDraftSignals", () => {
    it("returns nulls for a missing/unknown payload", () => {
        expect(getDraftSignals(null)).toEqual({ teamName: null, hero: null });
        expect(getDraftSignals(undefined)).toEqual({ teamName: null, hero: null });
        expect(getDraftSignals("not-an-object")).toEqual({ teamName: null, hero: null });
        expect(getDraftSignals({})).toEqual({ teamName: null, hero: null });
    });

    it("reads the player's team name", () => {
        expect(getDraftSignals({ player: { team_name: "radiant" } }).teamName).toBe(
            "radiant"
        );
        expect(getDraftSignals({ player: { team_name: "dire" } }).teamName).toBe("dire");
    });

    it("ignores an unrecognized team name", () => {
        expect(getDraftSignals({ player: { team_name: "spectator" } }).teamName).toBeNull();
    });

    it("resolves the player's own hero once hero.id is known", () => {
        const signals = getDraftSignals({ hero: { id: 1 } });
        expect(signals.hero?.id).toBe(1);
    });

    it("does not resolve a hero for an invalid or absent hero.id", () => {
        expect(getDraftSignals({ hero: { id: 0 } }).hero).toBeNull();
        expect(getDraftSignals({ hero: { id: -1 } }).hero).toBeNull();
        expect(getDraftSignals({ hero: {} }).hero).toBeNull();
        expect(getDraftSignals({ hero: { id: 999999 } }).hero).toBeNull();
    });

    it("never reads draft.* pick/ban fields, even if present in the payload", () => {
        const signals = getDraftSignals({
            draft: {
                activeteam: 2,
                team2: { pick0_id: 1, pick0_class: "npc_dota_hero_antimage" },
                team3: { pick0_id: 2 },
            },
            player: { team_name: "radiant" },
        });
        expect(signals).toEqual({ teamName: "radiant", hero: null });
    });
});
