export type GameType = "FREECELL" | "TETRIS";

// moves/time_seconds заполнены только у FREECELL-строк, score/lines/level -
// только у TETRIS-строк (см. миграцию в db/migrate.ts и ORDER_BY в
// solitaire-leaderboard-service.ts). level хранится только для отображения,
// в ранжировании не участвует.
export interface SolitaireLeaderboardEntry {
    id: number;
    player_name: string;
    game_type: GameType;
    moves: number | null;
    time_seconds: number | null;
    score: number | null;
    lines: number | null;
    level: number | null;
    created_at: string;
}
