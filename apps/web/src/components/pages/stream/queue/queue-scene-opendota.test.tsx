import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { StreamMatch } from "@/entities/stream-session/model/types";
import { FavoriteHeroes, PlayerProfileRadarPanel } from "./queue-scene-ui";

afterEach(cleanup);

// WK-148 - Between Matches OpenDota enrichment: Favorite Heroes secondary
// lines (lifetime + current-patch) and the "ПРОФИЛЬ ИГРОКА" radar. Both must
// degrade gracefully to their pre-WK-148 look when openDota is null (Steam
// not linked / cold cache / OpenDota down) - never a placeholder/error state
// on a live stream surface.

const baseProps = {
    email: null,
    gameMode: null as const,
    rating: null,
    wins: 0,
    losses: 0,
    steamConnected: false,
    steamId: undefined,
    steamSyncStatus: null,
    steamProfile: undefined,
    twitch: null,
    donationAlerts: null,
    webcamImageUrl: null,
    channelGoal: { type: "none" as const, label: "", startValue: 0, targetValue: 0 },
    activeSessionId: null,
};

describe("FavoriteHeroes OpenDota enrichment", () => {
    it("renders only the hero name when openDota is null (Steam not linked / cold cache)", () => {
        render(
            <FavoriteHeroes
                {...baseProps}
                matches={[]}
                selectedHeroIds={[1]}
                title="Favorite Heroes"
                openDota={null}
            />
        );
        expect(screen.getByText("Anti-Mage")).toBeTruthy();
        expect(screen.queryByText(/%/)).toBeNull();
    });

    it("renders the lifetime matches/winrate line as the primary enrichment", () => {
        render(
            <FavoriteHeroes
                {...baseProps}
                matches={[]}
                selectedHeroIds={[1]}
                title="Favorite Heroes"
                openDota={{
                    favoriteHeroes: {
                        patchName: null,
                        perHero: { 1: { lifetime: { games: 132, wins: 71, losses: 61, winRate: 53.79 }, patch: null } },
                    },
                    radar: null,
                }}
            />
        );
        expect(screen.getByText("132 · 53.8%")).toBeTruthy();
    });

    it("adds the current-patch secondary line when both patch stats and a resolved patch name are available", () => {
        render(
            <FavoriteHeroes
                {...baseProps}
                matches={[]}
                selectedHeroIds={[1]}
                title="Favorite Heroes"
                openDota={{
                    favoriteHeroes: {
                        patchName: "7.41",
                        perHero: {
                            1: {
                                lifetime: { games: 132, wins: 71, losses: 61, winRate: 53.79 },
                                patch: { games: 12, wins: 7, losses: 5, winRate: 58.3 },
                            },
                        },
                    },
                    radar: null,
                }}
            />
        );
        expect(screen.getByText("132 · 53.8%")).toBeTruthy();
        expect(screen.getByText("7.41 · 58%")).toBeTruthy();
    });

    it("omits the patch line when patch stats exist but the patch name could not be resolved", () => {
        render(
            <FavoriteHeroes
                {...baseProps}
                matches={[]}
                selectedHeroIds={[1]}
                title="Favorite Heroes"
                openDota={{
                    favoriteHeroes: {
                        patchName: null,
                        perHero: {
                            1: {
                                lifetime: { games: 132, wins: 71, losses: 61, winRate: 53.79 },
                                patch: { games: 12, wins: 7, losses: 5, winRate: 58.3 },
                            },
                        },
                    },
                    radar: null,
                }}
            />
        );
        expect(screen.getByText("132 · 53.8%")).toBeTruthy();
        expect(screen.queryByText(/58%/)).toBeNull();
    });

    it("does not enrich a hero missing from perHero (e.g. auto-selected, not yet warmed)", () => {
        render(
            <FavoriteHeroes
                {...baseProps}
                matches={[{ heroId: 2 } as StreamMatch]}
                selectedHeroIds={[]}
                title="Favorite Heroes"
                openDota={{
                    favoriteHeroes: { patchName: "7.41", perHero: {} },
                    radar: null,
                }}
            />
        );
        expect(screen.queryByText(/%/)).toBeNull();
    });
});

describe("PlayerProfileRadarPanel", () => {
    it("renders nothing when openDota is null", () => {
        const { container } = render(<PlayerProfileRadarPanel {...baseProps} matches={[]} openDota={null} />);
        expect(container.firstChild).toBeNull();
    });

    it("renders nothing when the sample is insufficient", () => {
        const { container } = render(
            <PlayerProfileRadarPanel
                {...baseProps}
                matches={[]}
                openDota={{
                    favoriteHeroes: null,
                    radar: { combat: null, farm: null, support: null, objectives: null, flexibility: null, insufficientSample: true },
                }}
            />
        );
        expect(container.firstChild).toBeNull();
    });

    it("renders the panel with a vertex per axis and integer value labels once there's a real profile", () => {
        render(
            <PlayerProfileRadarPanel
                {...baseProps}
                matches={[]}
                openDota={{
                    favoriteHeroes: null,
                    radar: { combat: 62, farm: 74.6, support: 41, objectives: null, flexibility: 55, insufficientSample: false },
                }}
            />
        );
        expect(screen.getByText("Профиль игрока")).toBeTruthy();
        expect(screen.getByText("БОЙ")).toBeTruthy();
        expect(screen.getByText("62")).toBeTruthy();
        expect(screen.getByText("75")).toBeTruthy(); // farm rounded from 74.6
        expect(screen.getByText("—")).toBeTruthy(); // objectives: null, not "0"
    });
});
