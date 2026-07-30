// Синтетические, обезличенные GSI-payload'ы для тестов пайплайна матчей
// (см. services/stream-match-service.ts). В репозитории нет реальных
// диагностических дампов GSI (companion пишет их только на клиенте
// пользователя, см. apps/dota-companion/src-tauri/src/diagnostics) - эти
// fixture построены по документированным сообществом полям (те же поля,
// что читает stream-match-service.ts: map.game_state/matchid/win_team/
// customgamename, player.activity/team_name/steamid/kills/deaths/assists,
// hero.id) и намеренно не содержат никаких токенов/личных данных.

export type FixtureTeam = "radiant" | "dire";

export interface GsiFixtureOptions {
    gameState: string;
    heroId?: number;
    teamName?: FixtureTeam;
    steamId?: string;
    matchId?: string | null;
    winTeam?: FixtureTeam | "none";
    customGameName?: string;
    kills?: number;
    deaths?: number;
    assists?: number;
    inventory?: Array<string | null>;
}

export const buildGsiPayload = (opts: GsiFixtureOptions): Record<string, unknown> => ({
    map: {
        game_state: opts.gameState,
        matchid: opts.matchId ?? "0",
        win_team: opts.winTeam ?? "none",
        customgamename: opts.customGameName ?? "",
    },
    player: {
        activity: "playing",
        team_name: opts.teamName ?? "radiant",
        steamid: opts.steamId ?? "76561198012345678",
        kills: opts.kills ?? 0,
        deaths: opts.deaths ?? 0,
        assists: opts.assists ?? 0,
    },
    hero: {
        id: opts.heroId ?? 1,
    },
    items: Object.fromEntries(
        (opts.inventory ?? []).map((name, index) => [
            `slot${index}`,
            { name: name ?? "empty" },
        ])
    ),
});

export const heroSelectionTick = (
    heroId: number,
    matchId?: string | null,
    teamName?: FixtureTeam
) => buildGsiPayload({ gameState: "DOTA_GAMERULES_STATE_HERO_SELECTION", heroId, matchId, teamName });

export const strategyTimeTick = (
    heroId: number,
    opts: { matchId?: string | null; teamName?: FixtureTeam } = {}
) =>
    buildGsiPayload({
        gameState: "DOTA_GAMERULES_STATE_STRATEGY_TIME",
        heroId,
        matchId: opts.matchId,
        teamName: opts.teamName,
    });

export const preGameTick = (
    heroId: number,
    opts: { matchId?: string | null; teamName?: FixtureTeam } = {}
) =>
    buildGsiPayload({
        gameState: "DOTA_GAMERULES_STATE_PRE_GAME",
        heroId,
        matchId: opts.matchId,
        teamName: opts.teamName,
    });

export const inProgressTick = (
    heroId: number,
    opts: { matchId?: string | null; teamName?: FixtureTeam; kills?: number; deaths?: number; assists?: number; inventory?: Array<string | null> } = {}
) =>
    buildGsiPayload({
        gameState: "DOTA_GAMERULES_STATE_GAME_IN_PROGRESS",
        heroId,
        matchId: opts.matchId,
        teamName: opts.teamName,
        kills: opts.kills,
        deaths: opts.deaths,
        assists: opts.assists,
        inventory: opts.inventory,
    });

export const postGameTick = (
    heroId: number,
    result: "win" | "loss",
    opts: { matchId?: string | null; teamName?: FixtureTeam; kills?: number; deaths?: number; assists?: number; inventory?: Array<string | null> } = {}
) => {
    const teamName = opts.teamName ?? "radiant";
    const winTeam: FixtureTeam = result === "win" ? teamName : teamName === "radiant" ? "dire" : "radiant";
    return buildGsiPayload({
        gameState: "DOTA_GAMERULES_STATE_POST_GAME",
        heroId,
        matchId: opts.matchId,
        teamName,
        winTeam,
        kills: opts.kills ?? 5,
        deaths: opts.deaths ?? 3,
        assists: opts.assists ?? 7,
        inventory: opts.inventory,
    });
};

// Послематчевый экран, где исход ещё не решён этим тиком (win_team ни
// "radiant", ни "dire") - GSI действительно присылает такие промежуточные
// payload'ы на переходе в POST_GAME (см. задачу: "GSI иногда не даёт
// достаточно данных").
export const postGameUndecidedTick = (heroId: number, matchId?: string | null) =>
    buildGsiPayload({ gameState: "DOTA_GAMERULES_STATE_POST_GAME", heroId, matchId, winTeam: "none" });

// Главное меню / вне матча - см. IN_MATCH_STATES в stream-match-service.ts.
export const mainMenuTick = (): Record<string, unknown> => ({
    map: {},
    player: { activity: "menu" },
});

export const customGameTick = (heroId: number, customGameName = "some_arcade_mode") =>
    buildGsiPayload({
        gameState: "DOTA_GAMERULES_STATE_GAME_IN_PROGRESS",
        heroId,
        customGameName,
    });
