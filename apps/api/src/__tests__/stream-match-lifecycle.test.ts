import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import bcrypt from "bcryptjs";
import { randomUUID } from "crypto";
import { pool } from "../db/client.js";
import { createTables } from "../db/migrate.js";
import { finalizeMatch, processGsiPayloadForMatch } from "../services/stream-match-service.js";
import { correctStreamMatch } from "../services/stream-match-correction-service.js";
import { setGameMode } from "../services/stream-user-service.js";
import { getOrCreateActiveSession, resetActiveSession } from "../services/stream-session-service.js";
import {
    heroSelectionTick,
    inProgressTick,
    mainMenuTick,
    postGameTick,
    postGameUndecidedTick,
    preGameTick,
    strategyTimeTick,
} from "./fixtures/gsi-payloads.js";

// Регрессии для укреплённого пайплайна обработки матчей (см. задачу):
// явный жизненный цикл (in_progress -> post_game_pending -> finalized /
// needs_review / interrupted), идемпотентная транзакционная финализация,
// реконнект/рестарт не плодят дубли, ranked/unranked строго разделены от
// самого факта изменения рейтинга, needs_review не трогает W/L/rating без
// подтверждения. Матчи создаются напрямую через processGsiPayloadForMatch
// (минуя companion-токен/HTTP), как и корректировка - через
// correctStreamMatch напрямую, как в существующем
// stream-overlay-session-reset.test.ts.

const suffix = `${Date.now()}-lifecycle`;
let userCounter = 0;
const createdUserIds: string[] = [];

const createTestUser = async (): Promise<string> => {
    userCounter += 1;
    const email = `stream_lifecycle_${suffix}_${userCounter}@example.com`;
    const hashed = await bcrypt.hash("test-password-123", 10);
    const result = await pool.query<{ id: number }>(
        `INSERT INTO stream_users (email, password_hash, public_token) VALUES ($1, $2, $3) RETURNING id`,
        [email, hashed, randomUUID()]
    );
    const id = result.rows[0].id.toString();
    createdUserIds.push(id);
    return id;
};

interface RawMatchRow {
    id: number;
    match_id: string | null;
    match_key: string;
    stream_session_id: number | null;
    hero_id: number;
    player_team: string | null;
    result: "win" | "loss" | "abandon" | null;
    state: string;
    is_ranked: boolean | null;
    mode_source: string | null;
    confidence: string;
    rating_delta: number | null;
    rating_before: number | null;
    rating_after: number | null;
    finalized_at: Date | null;
    interrupted_at: Date | null;
    inventory: Array<string | null>;
}

const getMatchRows = async (streamUserId: string): Promise<RawMatchRow[]> => {
    const result = await pool.query<RawMatchRow>(
        `SELECT id, match_id, match_key, stream_session_id, hero_id, player_team, result, state,
                is_ranked, mode_source, confidence, rating_before, rating_delta, rating_after, finalized_at, interrupted_at,
                inventory
         FROM stream_matches WHERE stream_user_id = $1 ORDER BY id ASC`,
        [streamUserId]
    );
    return result.rows;
};

const getActiveSession = async (streamUserId: string) => {
    const result = await pool.query<{
        id: number;
        wins: number;
        losses: number;
        rating: number | null;
        last_hero_id: number | null;
    }>(
        `SELECT id, wins, losses, rating, last_hero_id FROM stream_sessions
         WHERE stream_user_id = $1 AND ended_at IS NULL`,
        [streamUserId]
    );
    return result.rows[0];
};

const setSessionRating = async (streamUserId: string, rating: number) => {
    await pool.query(
        `UPDATE stream_sessions SET rating = $2 WHERE stream_user_id = $1 AND ended_at IS NULL`,
        [streamUserId, rating]
    );
};

beforeAll(async () => {
    await createTables();
});

afterAll(async () => {
    if (createdUserIds.length > 0) {
        await pool.query(`DELETE FROM stream_users WHERE id = ANY($1::int[])`, [
            createdUserIds.map(Number),
        ]);
    }
    await pool.end();
});

describe("stream match lifecycle", () => {
    it("ranked-win: needs a confirming second tick, then applies +25 and a win", async () => {
        const streamUserId = await createTestUser();

        await processGsiPayloadForMatch(streamUserId, heroSelectionTick(1, "700000001"));
        await setSessionRating(streamUserId, 5000);

        const finalInventory = [
            "item_tranquil_boots",
            "item_cyclone",
            null,
            "item_force_staff",
        ];
        await processGsiPayloadForMatch(
            streamUserId,
            postGameTick(1, "win", {
                matchId: "700000001",
                inventory: finalInventory,
            })
        );
        let rows = await getMatchRows(streamUserId);
        expect(rows).toHaveLength(1);
        expect(rows[0].state).toBe("post_game_pending");
        expect(rows[0].confidence).toBe("probable");

        await processGsiPayloadForMatch(
            streamUserId,
            postGameTick(1, "win", {
                matchId: "700000001",
                inventory: finalInventory,
            })
        );
        rows = await getMatchRows(streamUserId);
        expect(rows).toHaveLength(1);
        expect(rows[0].state).toBe("finalized");
        expect(rows[0].confidence).toBe("confirmed");
        expect(rows[0].is_ranked).toBe(true);
        expect(rows[0].rating_delta).toBe(25);
        expect(rows[0].inventory.slice(0, 4)).toEqual(finalInventory);
        expect(rows[0].rating_after).toBe(5025);

        const session = await getActiveSession(streamUserId);
        expect(session.wins).toBe(1);
        expect(session.losses).toBe(0);
        expect(session.rating).toBe(5025);
    });

    it("ranked-loss: applies -25 and a loss", async () => {
        const streamUserId = await createTestUser();

        await processGsiPayloadForMatch(streamUserId, heroSelectionTick(2, "700000002"));
        await setSessionRating(streamUserId, 5000);

        await processGsiPayloadForMatch(streamUserId, postGameTick(2, "loss", { matchId: "700000002" }));
        await processGsiPayloadForMatch(streamUserId, postGameTick(2, "loss", { matchId: "700000002" }));

        const rows = await getMatchRows(streamUserId);
        expect(rows).toHaveLength(1);
        expect(rows[0].state).toBe("finalized");
        expect(rows[0].rating_delta).toBe(-25);
        expect(rows[0].rating_after).toBe(4975);

        const session = await getActiveSession(streamUserId);
        expect(session.wins).toBe(0);
        expect(session.losses).toBe(1);
        expect(session.rating).toBe(4975);
    });

    it("unranked-after-ranked: W/L still counts, rating and mmrDelta stay untouched", async () => {
        const streamUserId = await createTestUser();
        await setGameMode(streamUserId, "unranked");

        await processGsiPayloadForMatch(streamUserId, heroSelectionTick(3, "700000003"));
        await setSessionRating(streamUserId, 6000);

        await processGsiPayloadForMatch(streamUserId, postGameTick(3, "loss", { matchId: "700000003" }));
        await processGsiPayloadForMatch(streamUserId, postGameTick(3, "loss", { matchId: "700000003" }));

        const rows = await getMatchRows(streamUserId);
        expect(rows[0].state).toBe("finalized");
        expect(rows[0].is_ranked).toBe(false);
        expect(rows[0].rating_delta).toBeNull();
        expect(rows[0].rating_after).toBeNull();

        const session = await getActiveSession(streamUserId);
        expect(session.losses).toBe(1);
        expect(session.rating).toBe(6000);
    });

    it("ranked started, switched to unranked mid-match: match still changes MMR (mode fixed at start)", async () => {
        const streamUserId = await createTestUser();

        await processGsiPayloadForMatch(streamUserId, heroSelectionTick(16, "700000016"));
        await setSessionRating(streamUserId, 5000);

        // Тумблер переключают уже ПОСЛЕ старта этого матча - должен
        // повлиять только на СЛЕДУЮЩИЙ создаваемый матч, не на этот.
        await setGameMode(streamUserId, "unranked");

        await processGsiPayloadForMatch(streamUserId, postGameTick(16, "win", { matchId: "700000016" }));
        await processGsiPayloadForMatch(streamUserId, postGameTick(16, "win", { matchId: "700000016" }));

        const rows = await getMatchRows(streamUserId);
        expect(rows[0].state).toBe("finalized");
        expect(rows[0].is_ranked).toBe(true);
        expect(rows[0].rating_delta).toBe(25);
        expect(rows[0].rating_after).toBe(5025);

        const session = await getActiveSession(streamUserId);
        expect(session.rating).toBe(5025);
    });

    it("unranked started, switched to ranked mid-match: match still does not change MMR", async () => {
        const streamUserId = await createTestUser();
        await setGameMode(streamUserId, "unranked");

        await processGsiPayloadForMatch(streamUserId, heroSelectionTick(17, "700000017"));
        await setSessionRating(streamUserId, 5000);

        // Переключают обратно в ranked уже ПОСЛЕ старта этого (unranked)
        // матча - не должно задним числом сделать его ranked.
        await setGameMode(streamUserId, "ranked");

        await processGsiPayloadForMatch(streamUserId, postGameTick(17, "loss", { matchId: "700000017" }));
        await processGsiPayloadForMatch(streamUserId, postGameTick(17, "loss", { matchId: "700000017" }));

        const rows = await getMatchRows(streamUserId);
        expect(rows[0].state).toBe("finalized");
        expect(rows[0].is_ranked).toBe(false);
        expect(rows[0].rating_delta).toBeNull();
        expect(rows[0].rating_after).toBeNull();

        const session = await getActiveSession(streamUserId);
        expect(session.losses).toBe(1);
        expect(session.rating).toBe(5000); // не тронут
    });

    // Резолюция режима теперь происходит при СОЗДАНИИ матча (createMatch),
    // а не на финализации (см. задачу, п.2) - поэтому мок читаемого
    // stream_users.game_mode должен стоять ДО первого тика, создающего
    // строку, а не только до POST_GAME.
    const mockUnknownGameMode = () => {
        const originalQuery = pool.query.bind(pool);
        return vi.spyOn(pool, "query").mockImplementation(((...args: unknown[]) => {
            const first = args[0];
            const sql = typeof first === "string" ? first : (first as { text?: string })?.text;
            if (typeof sql === "string" && sql.includes("SELECT game_mode FROM stream_users")) {
                return Promise.resolve({ rows: [{ game_mode: null }], rowCount: 1 } as never);
            }
            return (originalQuery as (...a: unknown[]) => unknown)(...args) as never;
        }) as typeof pool.query);
    };

    it("missing-lobby-type: unknown account mode never defaults to ranked", async () => {
        const streamUserId = await createTestUser();

        const spy = mockUnknownGameMode();
        try {
            await processGsiPayloadForMatch(streamUserId, heroSelectionTick(4, "700000004"));
        } finally {
            spy.mockRestore();
        }
        await setSessionRating(streamUserId, 4000);

        let rows = await getMatchRows(streamUserId);
        expect(rows[0].is_ranked).toBeNull(); // уже зафиксировано на создании, а не отложено

        await processGsiPayloadForMatch(streamUserId, postGameTick(4, "win", { matchId: "700000004" }));
        await processGsiPayloadForMatch(streamUserId, postGameTick(4, "win", { matchId: "700000004" }));

        rows = await getMatchRows(streamUserId);
        expect(rows[0].state).toBe("finalized");
        expect(rows[0].is_ranked).toBeNull();
        expect(rows[0].rating_delta).toBeNull();

        const session = await getActiveSession(streamUserId);
        expect(session.wins).toBe(1); // подтверждённый результат всё равно засчитан
        expect(session.rating).toBe(4000); // но рейтинг не тронут
    });

    it("unknown mode started, later switched to ranked mid-match: match stays unknown, MMR untouched", async () => {
        const streamUserId = await createTestUser();

        const spy = mockUnknownGameMode();
        try {
            await processGsiPayloadForMatch(streamUserId, heroSelectionTick(15, "700000015"));
        } finally {
            spy.mockRestore();
        }
        await setSessionRating(streamUserId, 5500);

        // Аккаунт "включают в ranked" уже ПОСЛЕ старта этого матча.
        await setGameMode(streamUserId, "ranked");

        await processGsiPayloadForMatch(streamUserId, postGameTick(15, "win", { matchId: "700000015" }));
        await processGsiPayloadForMatch(streamUserId, postGameTick(15, "win", { matchId: "700000015" }));

        const rows = await getMatchRows(streamUserId);
        expect(rows[0].state).toBe("finalized");
        expect(rows[0].is_ranked).toBeNull(); // остаётся unknown, не "ranked" задним числом
        expect(rows[0].rating_delta).toBeNull();

        const session = await getActiveSession(streamUserId);
        expect(session.rating).toBe(5500); // не тронут
    });

    it("missing-match-id: falls back to synthetic identity, still finalizes exactly once", async () => {
        const streamUserId = await createTestUser();

        await processGsiPayloadForMatch(streamUserId, heroSelectionTick(5)); // no matchId (bot lobby)
        await processGsiPayloadForMatch(streamUserId, inProgressTick(5));
        await processGsiPayloadForMatch(streamUserId, postGameTick(5, "loss"));
        await processGsiPayloadForMatch(streamUserId, postGameTick(5, "loss"));

        const rows = await getMatchRows(streamUserId);
        expect(rows).toHaveLength(1);
        expect(rows[0].match_id).toBeNull();
        expect(rows[0].state).toBe("finalized");
        expect(rows[0].result).toBe("loss");

        const session = await getActiveSession(streamUserId);
        expect(session.losses).toBe(1);
    });

    it("duplicate-post-game: replaying an already-finalized tick changes nothing", async () => {
        const streamUserId = await createTestUser();

        await processGsiPayloadForMatch(streamUserId, heroSelectionTick(6, "700000006"));
        await setSessionRating(streamUserId, 3000);

        await processGsiPayloadForMatch(streamUserId, postGameTick(6, "win", { matchId: "700000006" }));
        await processGsiPayloadForMatch(streamUserId, postGameTick(6, "win", { matchId: "700000006" }));

        let rows = await getMatchRows(streamUserId);
        expect(rows).toHaveLength(1);
        expect(rows[0].state).toBe("finalized");

        // GSI может продолжать слать POST_GAME-тики, пока игрок сидит на
        // экране статистики уже ПОСЛЕ того, как матч финализирован.
        await processGsiPayloadForMatch(streamUserId, postGameTick(6, "win", { matchId: "700000006" }));
        await processGsiPayloadForMatch(streamUserId, postGameTick(6, "win", { matchId: "700000006" }));

        rows = await getMatchRows(streamUserId);
        expect(rows).toHaveLength(1);
        const session = await getActiveSession(streamUserId);
        expect(session.wins).toBe(1);
        expect(session.rating).toBe(3025);
    });

    it("reconnect-same-match: an interrupted match resumes instead of creating a new row", async () => {
        const streamUserId = await createTestUser();

        await processGsiPayloadForMatch(streamUserId, heroSelectionTick(7, "700000007"));
        let rows = await getMatchRows(streamUserId);
        expect(rows).toHaveLength(1);
        const matchRowId = rows[0].id;

        // Дисконнект - тик из главного меню.
        await processGsiPayloadForMatch(streamUserId, mainMenuTick());
        rows = await getMatchRows(streamUserId);
        expect(rows).toHaveLength(1);
        expect(rows[0].state).toBe("interrupted");

        // Реконнект к тому же матчу (тот же matchId).
        await processGsiPayloadForMatch(
            streamUserId,
            inProgressTick(7, { matchId: "700000007" })
        );
        rows = await getMatchRows(streamUserId);
        expect(rows).toHaveLength(1);
        expect(rows[0].id).toBe(matchRowId);
        expect(rows[0].state).toBe("in_progress");

        await processGsiPayloadForMatch(streamUserId, postGameTick(7, "win", { matchId: "700000007" }));
        await processGsiPayloadForMatch(streamUserId, postGameTick(7, "win", { matchId: "700000007" }));

        rows = await getMatchRows(streamUserId);
        expect(rows).toHaveLength(1);
        expect(rows[0].state).toBe("finalized");
        expect(rows[0].state).not.toBe("needs_review");
    });

    it("companion-restart: DB state is authoritative, no process-local memory required", async () => {
        const streamUserId = await createTestUser();

        // Тик "до рестарта".
        await processGsiPayloadForMatch(streamUserId, heroSelectionTick(8, "700000008"));
        let rows = await getMatchRows(streamUserId);
        expect(rows).toHaveLength(1);
        expect(rows[0].state).toBe("in_progress");

        // processGsiPayloadForMatch не хранит process-local состояния (нет
        // module-level Map) - следующий вызов неотличим от вызова в новом
        // процессе после рестарта backend, он обязан найти существующую
        // строку в БД, а не завести вторую.
        await processGsiPayloadForMatch(streamUserId, inProgressTick(8, { matchId: "700000008" }));
        rows = await getMatchRows(streamUserId);
        expect(rows).toHaveLength(1);

        await processGsiPayloadForMatch(streamUserId, postGameTick(8, "win", { matchId: "700000008" }));
        await processGsiPayloadForMatch(streamUserId, postGameTick(8, "win", { matchId: "700000008" }));
        rows = await getMatchRows(streamUserId);
        expect(rows).toHaveLength(1);
        expect(rows[0].state).toBe("finalized");
    });

    it("new-match-before-old-finalized: old match goes to needs_review, new one attaches to the active session", async () => {
        const streamUserId = await createTestUser();
        // Non-null: streamUserId is freshly created, so this is a true
        // first-run getOrCreateActiveSession call - always creates a session.
        const activeSession = (await getOrCreateActiveSession(streamUserId))!;

        await processGsiPayloadForMatch(streamUserId, heroSelectionTick(9, "700000009"));
        let rows = await getMatchRows(streamUserId);
        expect(rows).toHaveLength(1);
        const oldMatchId = rows[0].id;

        // Другой герой и другой matchId - явно другой матч, старый ещё не
        // дошёл даже до post_game_pending.
        await processGsiPayloadForMatch(streamUserId, heroSelectionTick(10, "700000010"));

        rows = await getMatchRows(streamUserId);
        expect(rows).toHaveLength(2);
        const oldMatch = rows.find((row) => row.id === oldMatchId)!;
        const newMatch = rows.find((row) => row.id !== oldMatchId)!;

        expect(oldMatch.state).toBe("needs_review");
        expect(newMatch.stream_session_id).toBe(Number(activeSession.id));
    });

    it("new-session: a match keeps the session it started in even after a mid-match reset", async () => {
        const streamUserId = await createTestUser();
        // Non-null: true first-run call for a freshly created user.
        const originalSession = (await getOrCreateActiveSession(streamUserId))!;

        await processGsiPayloadForMatch(streamUserId, heroSelectionTick(11, "700000011"));
        let rows = await getMatchRows(streamUserId);
        expect(rows).toHaveLength(1);
        expect(rows[0].stream_session_id).toBe(Number(originalSession.id));

        // "Начать новый стрим" посреди ещё не завершённого матча.
        const newSession = await resetActiveSession(streamUserId);
        expect(newSession.id).not.toBe(originalSession.id);

        await processGsiPayloadForMatch(streamUserId, postGameTick(11, "win", { matchId: "700000011" }));
        await processGsiPayloadForMatch(streamUserId, postGameTick(11, "win", { matchId: "700000011" }));

        rows = await getMatchRows(streamUserId);
        expect(rows).toHaveLength(1);
        expect(rows[0].state).toBe("finalized");
        // Матч остаётся привязан к СТАРОЙ (уже закрытой) сессии - не новой.
        expect(rows[0].stream_session_id).toBe(Number(originalSession.id));

        const oldSessionRow = await pool.query<{ wins: number }>(
            `SELECT wins FROM stream_sessions WHERE id = $1`,
            [originalSession.id]
        );
        expect(oldSessionRow.rows[0].wins).toBe(1);

        const newSessionRow = await pool.query<{ wins: number }>(
            `SELECT wins FROM stream_sessions WHERE id = $1`,
            [newSession.id]
        );
        expect(newSessionRow.rows[0].wins).toBe(0);
    });

    it("manual correction of a needs_review match uses the mode captured at match start, not the current account toggle", async () => {
        const streamUserId = await createTestUser();

        // Матч создаётся, пока аккаунт ranked - is_ranked=true фиксируется
        // прямо сейчас.
        await processGsiPayloadForMatch(streamUserId, heroSelectionTick(18, "700000018"));
        await setSessionRating(streamUserId, 5000);
        await processGsiPayloadForMatch(streamUserId, postGameTick(18, "win", { matchId: "700000018" }));
        await processGsiPayloadForMatch(streamUserId, postGameTick(18, "loss", { matchId: "700000018" })); // конфликт -> needs_review

        let rows = await getMatchRows(streamUserId);
        expect(rows[0].state).toBe("needs_review");
        expect(rows[0].is_ranked).toBe(true); // не сброшено needs_review-переходом

        // Аккаунт переключают в unranked УЖЕ ПОСЛЕ того, как матч начался.
        await setGameMode(streamUserId, "unranked");

        const resolved = await correctStreamMatch(streamUserId, rows[0].id.toString(), { result: "win" });
        expect(resolved.match.state).toBe("finalized");
        // Ручное разрешение использует is_ranked, зафиксированный на СТАРТЕ
        // матча (true), а не текущий (уже unranked) тумблер аккаунта.
        expect(resolved.match.isRanked).toBe(true);
        expect(resolved.match.ratingDelta).toBe(25);
        expect(resolved.session?.rating).toBe(5025);
    });

    it("needs_review resolution via manual correction counts exactly once, discard counts nothing", async () => {
        const streamUserId = await createTestUser();

        await processGsiPayloadForMatch(streamUserId, heroSelectionTick(12, "700000012"));
        await setSessionRating(streamUserId, 5000);
        await processGsiPayloadForMatch(streamUserId, postGameTick(12, "win", { matchId: "700000012" }));
        // Противоречащее наблюдение - другой win_team на следующем тике.
        await processGsiPayloadForMatch(streamUserId, postGameTick(12, "loss", { matchId: "700000012" }));

        let rows = await getMatchRows(streamUserId);
        expect(rows).toHaveLength(1);
        expect(rows[0].state).toBe("needs_review");
        expect(rows[0].result).toBeNull();

        const resolved = await correctStreamMatch(streamUserId, rows[0].id.toString(), { result: "win" });
        expect(resolved.match.state).toBe("finalized");
        expect(resolved.match.result).toBe("win");
        expect(resolved.session?.wins).toBe(1);
        expect(resolved.session?.losses).toBe(0);

        // Повторный идентичный PATCH не должен посчитать матч дважды.
        const resolvedAgain = await correctStreamMatch(streamUserId, rows[0].id.toString(), {
            result: "win",
        });
        expect(resolvedAgain.session?.wins).toBe(1);

        // Второй матч, разрешённый через "не учитывать" - W/L не меняется.
        const streamUserId2 = await createTestUser();
        await processGsiPayloadForMatch(streamUserId2, heroSelectionTick(13, "700000013"));
        await processGsiPayloadForMatch(streamUserId2, postGameTick(13, "win", { matchId: "700000013" }));
        await processGsiPayloadForMatch(streamUserId2, postGameTick(13, "loss", { matchId: "700000013" }));

        rows = await getMatchRows(streamUserId2);
        expect(rows[0].state).toBe("needs_review");

        const discarded = await correctStreamMatch(streamUserId2, rows[0].id.toString(), { discard: true });
        expect(discarded.match.state).toBe("finalized");
        expect(discarded.session).toBeNull();

        const session2 = await getActiveSession(streamUserId2);
        expect(session2.wins).toBe(0);
        expect(session2.losses).toBe(0);
    });

    it("concurrent double finalization changes session aggregates exactly once", async () => {
        const streamUserId = await createTestUser();

        await processGsiPayloadForMatch(streamUserId, heroSelectionTick(14, "700000014"));
        await setSessionRating(streamUserId, 4500);
        await processGsiPayloadForMatch(streamUserId, postGameTick(14, "win", { matchId: "700000014" }));

        const rows = await getMatchRows(streamUserId);
        expect(rows).toHaveLength(1);
        expect(rows[0].state).toBe("post_game_pending");
        const matchRowId = rows[0].id;

        const [a, b] = await Promise.all([
            finalizeMatch(matchRowId, "race_a", "confirmed"),
            finalizeMatch(matchRowId, "race_b", "confirmed"),
        ]);
        expect([a, b].filter(Boolean)).toHaveLength(1);

        const session = await getActiveSession(streamUserId);
        expect(session.wins).toBe(1);
        expect(session.rating).toBe(4525);
    });
});

// Точечный аудит: hero_id один сам по себе не является надёжной
// идентичностью матча (см. задачу) - без match_id нужно ЕЩЁ совпадение
// команды, отсутствие сигналов "это новый матч" (hero-selection/strategy/
// pre-game после разрыва - реконнект возобновляется сразу в
// game_in_progress/post_game) и ограниченное окно с момента разрыва.
describe("match identity: hero_id alone is never sufficient", () => {
    it("two consecutive matches on the same hero without match_id are NOT merged", async () => {
        const streamUserId = await createTestUser();

        await processGsiPayloadForMatch(streamUserId, heroSelectionTick(20)); // no matchId
        let rows = await getMatchRows(streamUserId);
        expect(rows).toHaveLength(1);
        const oldMatchId = rows[0].id;
        const oldMatchRunId = rows[0].match_key;

        // Разрыв соединения - матч остаётся interrupted, так и не дойдя до
        // послематчевого экрана.
        await processGsiPayloadForMatch(streamUserId, mainMenuTick());
        rows = await getMatchRows(streamUserId);
        expect(rows[0].state).toBe("interrupted");

        // Пользователь начинает НОВЫЙ матч на том же герое - тик снова
        // hero-selection (надёжный сигнал "это новый матч", реконнект к уже
        // идущему матчу так не выглядит).
        await processGsiPayloadForMatch(streamUserId, heroSelectionTick(20));

        rows = await getMatchRows(streamUserId);
        expect(rows).toHaveLength(2);
        const oldMatch = rows.find((row) => row.id === oldMatchId)!;
        const newMatch = rows.find((row) => row.id !== oldMatchId)!;

        expect(oldMatch.state).toBe("needs_review");
        expect(newMatch.match_key).not.toBe(oldMatchRunId);
        expect(newMatch.state).toBe("in_progress");
    });

    it("a genuine reconnect to the same match (same hero+team, resumes mid-game) is NOT a new match", async () => {
        const streamUserId = await createTestUser();

        await processGsiPayloadForMatch(streamUserId, heroSelectionTick(21)); // no matchId
        let rows = await getMatchRows(streamUserId);
        const matchRowId = rows[0].id;

        await processGsiPayloadForMatch(streamUserId, mainMenuTick());
        rows = await getMatchRows(streamUserId);
        expect(rows[0].state).toBe("interrupted");

        // Реконнект возобновляется сразу в GAME_IN_PROGRESS (не заново в
        // hero-selection) - тот же герой, та же команда, без match_id.
        await processGsiPayloadForMatch(streamUserId, inProgressTick(21, { teamName: "radiant" }));

        rows = await getMatchRows(streamUserId);
        expect(rows).toHaveLength(1);
        expect(rows[0].id).toBe(matchRowId);
        expect(rows[0].state).toBe("in_progress");
    });

    it("a different known match_id on the same hero is always a new match", async () => {
        const streamUserId = await createTestUser();

        await processGsiPayloadForMatch(streamUserId, heroSelectionTick(22, "800000001"));
        let rows = await getMatchRows(streamUserId);
        const oldMatchId = rows[0].id;

        // Тот же герой, но другой известный match_id - жёсткое правило:
        // разный match_id => новый матч, hero_id роли не играет.
        await processGsiPayloadForMatch(streamUserId, heroSelectionTick(22, "800000002"));

        rows = await getMatchRows(streamUserId);
        expect(rows).toHaveLength(2);
        const oldMatch = rows.find((row) => row.id === oldMatchId)!;
        const newMatch = rows.find((row) => row.id !== oldMatchId)!;
        expect(oldMatch.state).toBe("needs_review");
        expect(newMatch.match_id).toBe("800000002");
    });

    it("match_id revealed after match start backfills the same row (not a new match)", async () => {
        const streamUserId = await createTestUser();

        await processGsiPayloadForMatch(streamUserId, heroSelectionTick(23)); // no matchId yet
        const rows0 = await getMatchRows(streamUserId);
        expect(rows0[0].match_id).toBeNull();
        const matchRowId = rows0[0].id;

        // Тот же герой/команда, GSI теперь наконец прислал matchid - не
        // hero-selection тик (продолжение уже идущего матча).
        await processGsiPayloadForMatch(
            streamUserId,
            inProgressTick(23, { matchId: "800000010", teamName: "radiant" })
        );

        const rows1 = await getMatchRows(streamUserId);
        expect(rows1).toHaveLength(1);
        expect(rows1[0].id).toBe(matchRowId);
        expect(rows1[0].match_id).toBe("800000010");
        expect(rows1[0].state).toBe("in_progress");
    });

    it("same hero but a different player team (no match_id) is treated as a different match", async () => {
        const streamUserId = await createTestUser();

        await processGsiPayloadForMatch(
            streamUserId,
            heroSelectionTick(24, undefined, "radiant")
        );
        let rows = await getMatchRows(streamUserId);
        const oldMatchId = rows[0].id;

        // Тот же герой, но другая команда, без match_id - недостаточно для
        // "того же матча", даже если GSI не подавал явного сигнала о начале
        // нового (gameState тут GAME_IN_PROGRESS, не hero-selection).
        await processGsiPayloadForMatch(
            streamUserId,
            inProgressTick(24, { teamName: "dire" })
        );

        rows = await getMatchRows(streamUserId);
        expect(rows).toHaveLength(2);
        const oldMatch = rows.find((row) => row.id === oldMatchId)!;
        const newMatch = rows.find((row) => row.id !== oldMatchId)!;
        expect(oldMatch.state).toBe("needs_review");
        expect(newMatch.player_team).toBe("dire");
    });
});

// Точечный аудит: уход игрока/обрыв соединения/отсутствие следующего payload
// сам по себе НИКОГДА не подтверждает результат - финализация при уходе
// допустима только если ДО этого было надёжное наблюдение (валидный
// win_team, из которого однозначно вычислен win/loss, без противоречий).
describe("finalization on leave never invents a result", () => {
    it("player leaves without ever seeing a win_team: in_progress -> interrupted, nothing changes", async () => {
        const streamUserId = await createTestUser();
        // Non-null: true first-run call for a freshly created user.
        const before = (await getOrCreateActiveSession(streamUserId))!;

        await processGsiPayloadForMatch(streamUserId, heroSelectionTick(30, "800000030"));
        await processGsiPayloadForMatch(streamUserId, mainMenuTick());

        const rows = await getMatchRows(streamUserId);
        expect(rows[0].state).toBe("interrupted");
        expect(rows[0].finalized_at).toBeNull();

        const after = await getActiveSession(streamUserId);
        expect(after.wins).toBe(before.wins);
        expect(after.losses).toBe(before.losses);
        expect(after.rating).toBe(before.rating);
    });

    it("backend stops receiving payloads (silence) without win_team: match just stays in_progress, nothing auto-finalizes", async () => {
        const streamUserId = await createTestUser();

        await processGsiPayloadForMatch(streamUserId, heroSelectionTick(31, "800000031"));
        // Ни одного дальнейшего вызова - имитирует "companion/Dota закрылись,
        // backend больше не получает payload". В проекте нет watchdog/cron,
        // который сам финализировал бы матч по таймауту - состояние должно
        // остаться прежним бессрочно, а не превратиться в finalized само по себе.
        const rows = await getMatchRows(streamUserId);
        expect(rows).toHaveLength(1);
        expect(rows[0].state).toBe("in_progress");
        expect(rows[0].finalized_at).toBeNull();
    });

    it("single confirmed win_team observation, then a clean leave: finalizes as probable", async () => {
        const streamUserId = await createTestUser();
        await processGsiPayloadForMatch(streamUserId, heroSelectionTick(32, "800000032"));
        await setSessionRating(streamUserId, 5000);

        await processGsiPayloadForMatch(streamUserId, postGameTick(32, "win", { matchId: "800000032" }));
        let rows = await getMatchRows(streamUserId);
        expect(rows[0].state).toBe("post_game_pending");
        expect(rows[0].result).toBe("win");

        // Уход с послематчевого экрана без второго (противоречащего или
        // подтверждающего) наблюдения.
        await processGsiPayloadForMatch(streamUserId, mainMenuTick());

        rows = await getMatchRows(streamUserId);
        expect(rows[0].state).toBe("finalized");
        expect(rows[0].result).toBe("win");
        expect(rows[0].confidence).toBe("probable");

        const session = await getActiveSession(streamUserId);
        expect(session.wins).toBe(1);
        expect(session.rating).toBe(5025);
    });

    it("one win_team observation, then a contradicting one: needs_review, nothing changes", async () => {
        const streamUserId = await createTestUser();

        await processGsiPayloadForMatch(streamUserId, heroSelectionTick(33, "800000033"));
        const before = await getActiveSession(streamUserId);

        await processGsiPayloadForMatch(streamUserId, postGameTick(33, "win", { matchId: "800000033" }));
        await processGsiPayloadForMatch(streamUserId, postGameTick(33, "loss", { matchId: "800000033" }));

        const rows = await getMatchRows(streamUserId);
        expect(rows[0].state).toBe("needs_review");
        expect(rows[0].result).toBeNull();
        expect(rows[0].finalized_at).toBeNull();

        const after = await getActiveSession(streamUserId);
        expect(after.wins).toBe(before.wins);
        expect(after.losses).toBe(before.losses);
        expect(after.rating).toBe(before.rating);
    });

    it("one ambiguous POST_GAME payload (no resolvable win_team), then the connection drops: needs_review, nothing changes", async () => {
        const streamUserId = await createTestUser();

        await processGsiPayloadForMatch(streamUserId, heroSelectionTick(34, "800000034"));
        const before = await getActiveSession(streamUserId);

        await processGsiPayloadForMatch(streamUserId, postGameUndecidedTick(34, "800000034"));
        let rows = await getMatchRows(streamUserId);
        expect(rows[0].state).toBe("post_game_pending");
        expect(rows[0].result).toBeNull();

        await processGsiPayloadForMatch(streamUserId, mainMenuTick());

        rows = await getMatchRows(streamUserId);
        expect(rows[0].state).toBe("needs_review");
        expect(rows[0].finalized_at).toBeNull();

        const after = await getActiveSession(streamUserId);
        expect(after.wins).toBe(before.wins);
        expect(after.losses).toBe(before.losses);
        expect(after.rating).toBe(before.rating);
    });

    it("Dota closes mid-match (in_progress, never reaches post-game): interrupted, nothing changes", async () => {
        const streamUserId = await createTestUser();
        // Non-null: true first-run call for a freshly created user.
        const before = (await getOrCreateActiveSession(streamUserId))!;

        await processGsiPayloadForMatch(streamUserId, heroSelectionTick(35, "800000035"));
        await processGsiPayloadForMatch(streamUserId, inProgressTick(35, { matchId: "800000035" }));
        // Dota/companion закрываются - GSI перестаёт слать payload
        // полностью. Последний живой сигнал, который companion успевает
        // отправить при закрытии - переход активности вне игры, если он
        // вообще происходит; здесь моделируем худший случай (полная тишина)
        // напрямую следующим тиком, отражающим потерю связи.
        await processGsiPayloadForMatch(streamUserId, mainMenuTick());

        const rows = await getMatchRows(streamUserId);
        expect(rows[0].state).toBe("interrupted");
        expect(rows[0].finalized_at).toBeNull();

        const after = await getActiveSession(streamUserId);
        expect(after.wins).toBe(before.wins);
        expect(after.losses).toBe(before.losses);
        expect(after.rating).toBe(before.rating);
    });
});

// Регрессия по реальному диагностическому дампу: hero_id матча раньше
// фиксировался НАВСЕГДА первым ненулевым значением на createMatch и никогда
// не обновлялся дальше (resumeMatch трогал только match_id/interrupted_at).
// В результате матч, где игрок сначала выбрал Snapfire (сброшен/забанен),
// затем Techies (забанен противником) и в итоге сыграл на Treant, сохранял
// в истории предварительный пик, а не фактически сыгранного героя. Герой у
// незавершённого матча - изменяемое наблюдаемое значение (см. resumeMatch в
// stream-match-service.ts), а не immutable-идентификатор.
describe("hero_id is an observed, mutable value - not a fixed identity", () => {
    it("real-world reproduction: Snapfire -> Techies -> Treant during one continuous draft, single match_id", async () => {
        const streamUserId = await createTestUser();
        const matchId = "8915861709";

        // 11:53:01 - первый пик, Snapfire.
        await processGsiPayloadForMatch(streamUserId, heroSelectionTick(128, matchId));
        // 11:53:09 - сброшен/забанен (hero_id=0 - штатный промежуточный тик).
        await processGsiPayloadForMatch(streamUserId, heroSelectionTick(0, matchId));
        // 11:53:17 - второй пик, Techies.
        await processGsiPayloadForMatch(streamUserId, heroSelectionTick(105, matchId));
        // 11:53:35 - Techies забанен противником, сброшен.
        await processGsiPayloadForMatch(streamUserId, heroSelectionTick(0, matchId));
        // 11:53:43 - итоговый пик, Treant Protector.
        await processGsiPayloadForMatch(streamUserId, heroSelectionTick(83, matchId));
        await processGsiPayloadForMatch(streamUserId, strategyTimeTick(83, { matchId }));
        await processGsiPayloadForMatch(streamUserId, preGameTick(83, { matchId }));
        await processGsiPayloadForMatch(streamUserId, inProgressTick(83, { matchId }));
        await setSessionRating(streamUserId, 5000);

        await processGsiPayloadForMatch(
            streamUserId,
            postGameTick(83, "loss", { matchId, kills: 4, deaths: 12, assists: 10 })
        );
        // Подтверждающий тик - тот же экран статистики, тот же исход.
        await processGsiPayloadForMatch(
            streamUserId,
            postGameTick(83, "loss", { matchId, kills: 4, deaths: 12, assists: 10 })
        );

        const rows = await getMatchRows(streamUserId);
        expect(rows).toHaveLength(1);
        expect(rows[0].match_id).toBe(matchId);
        expect(rows[0].hero_id).toBe(83);
        expect(rows[0].result).toBe("loss");
        expect(rows[0].state).toBe("finalized");
        // Смена героя внутри одного match_id никогда не переводит матч в
        // needs_review - только конфликтующие исходы (см. markPostGame).
        expect(rows[0].state).not.toBe("needs_review");

        const session = await getActiveSession(streamUserId);
        expect(session.last_hero_id).toBe(83);
    });

    it("a second, unrelated match on a new match_id is tracked separately with its own hero", async () => {
        const streamUserId = await createTestUser();
        const firstMatchId = "8915861709";
        const secondMatchId = "8915895118";

        await processGsiPayloadForMatch(streamUserId, heroSelectionTick(83, firstMatchId));
        await processGsiPayloadForMatch(streamUserId, inProgressTick(83, { matchId: firstMatchId }));
        await processGsiPayloadForMatch(
            streamUserId,
            postGameTick(83, "loss", { matchId: firstMatchId, kills: 4, deaths: 12, assists: 10 })
        );
        await processGsiPayloadForMatch(
            streamUserId,
            postGameTick(83, "loss", { matchId: firstMatchId, kills: 4, deaths: 12, assists: 10 })
        );

        // Techies от выбора и до конца - герой ни разу не меняется.
        await processGsiPayloadForMatch(streamUserId, heroSelectionTick(105, secondMatchId));
        await processGsiPayloadForMatch(streamUserId, strategyTimeTick(105, { matchId: secondMatchId }));
        await processGsiPayloadForMatch(streamUserId, preGameTick(105, { matchId: secondMatchId }));
        await processGsiPayloadForMatch(streamUserId, inProgressTick(105, { matchId: secondMatchId }));
        await processGsiPayloadForMatch(
            streamUserId,
            postGameTick(105, "win", { matchId: secondMatchId, kills: 9, deaths: 9, assists: 24 })
        );
        await processGsiPayloadForMatch(
            streamUserId,
            postGameTick(105, "win", { matchId: secondMatchId, kills: 9, deaths: 9, assists: 24 })
        );

        const rows = await getMatchRows(streamUserId);
        expect(rows).toHaveLength(2);
        const firstMatch = rows.find((row) => row.match_id === firstMatchId)!;
        const secondMatch = rows.find((row) => row.match_id === secondMatchId)!;
        expect(firstMatch.hero_id).toBe(83);
        expect(secondMatch.hero_id).toBe(105);
        expect(secondMatch.result).toBe("win");

        const session = await getActiveSession(streamUserId);
        expect(session.last_hero_id).toBe(105);
    });

    it("ordinary single hero pick: no swap, hero_id is exactly what was picked", async () => {
        const streamUserId = await createTestUser();

        await processGsiPayloadForMatch(streamUserId, heroSelectionTick(50, "900000101"));
        await processGsiPayloadForMatch(streamUserId, postGameTick(50, "win", { matchId: "900000101" }));
        await processGsiPayloadForMatch(streamUserId, postGameTick(50, "win", { matchId: "900000101" }));

        const rows = await getMatchRows(streamUserId);
        expect(rows).toHaveLength(1);
        expect(rows[0].hero_id).toBe(50);
    });

    it("hero swap in PRE_GAME (same match_id) updates the row instead of splitting it", async () => {
        const streamUserId = await createTestUser();
        const matchId = "900000102";

        await processGsiPayloadForMatch(streamUserId, heroSelectionTick(51, matchId));
        await processGsiPayloadForMatch(streamUserId, preGameTick(51, { matchId }));
        // Обмен героями ещё до начала игры - PRE_GAME, тот же match_id.
        await processGsiPayloadForMatch(streamUserId, preGameTick(52, { matchId }));

        let rows = await getMatchRows(streamUserId);
        expect(rows).toHaveLength(1);
        expect(rows[0].hero_id).toBe(52);
        expect(rows[0].state).not.toBe("needs_review");

        await processGsiPayloadForMatch(streamUserId, postGameTick(52, "win", { matchId }));
        await processGsiPayloadForMatch(streamUserId, postGameTick(52, "win", { matchId }));

        rows = await getMatchRows(streamUserId);
        expect(rows).toHaveLength(1);
        expect(rows[0].hero_id).toBe(52);
        expect(rows[0].state).toBe("finalized");
    });

    it("hero swap after the first GAME_IN_PROGRESS tick (same match_id) is tracked, not frozen", async () => {
        const streamUserId = await createTestUser();
        const matchId = "900000103";

        await processGsiPayloadForMatch(streamUserId, heroSelectionTick(53, matchId));
        await processGsiPayloadForMatch(streamUserId, inProgressTick(53, { matchId }));
        // Игра уже идёт (GAME_IN_PROGRESS уже наблюдался) - и только теперь
        // происходит обмен героями.
        await processGsiPayloadForMatch(streamUserId, inProgressTick(54, { matchId }));

        let rows = await getMatchRows(streamUserId);
        expect(rows).toHaveLength(1);
        expect(rows[0].hero_id).toBe(54);

        await processGsiPayloadForMatch(
            streamUserId,
            postGameTick(54, "win", { matchId, kills: 6, deaths: 2, assists: 11 })
        );
        await processGsiPayloadForMatch(
            streamUserId,
            postGameTick(54, "win", { matchId, kills: 6, deaths: 2, assists: 11 })
        );

        rows = await getMatchRows(streamUserId);
        expect(rows).toHaveLength(1);
        expect(rows[0].hero_id).toBe(54);
        expect(rows[0].result).toBe("win");
        expect(rows[0].state).toBe("finalized");
    });

    it("repeated POST_GAME ticks after finalization do not change hero or stats again", async () => {
        const streamUserId = await createTestUser();
        const matchId = "900000104";

        await processGsiPayloadForMatch(streamUserId, heroSelectionTick(55, matchId));
        await processGsiPayloadForMatch(
            streamUserId,
            postGameTick(55, "win", { matchId, kills: 3, deaths: 1, assists: 2 })
        );
        await processGsiPayloadForMatch(
            streamUserId,
            postGameTick(55, "win", { matchId, kills: 3, deaths: 1, assists: 2 })
        );

        let rows = await getMatchRows(streamUserId);
        expect(rows[0].state).toBe("finalized");
        expect(rows[0].hero_id).toBe(55);

        // GSI продолжает слать POST_GAME с другим "героем" (испорченный/
        // повторный payload) уже ПОСЛЕ финализации - findActiveMatch не
        // находит эту строку (она finalized), поэтому позднему тику нечего
        // обновлять.
        await processGsiPayloadForMatch(
            streamUserId,
            postGameTick(99, "loss", { matchId, kills: 0, deaths: 0, assists: 0 })
        );

        rows = await getMatchRows(streamUserId);
        expect(rows).toHaveLength(1);
        expect(rows[0].hero_id).toBe(55);
        expect(rows[0].result).toBe("win");
    });

    it("late payload for an already-finalized match_id with a different hero_id is ignored", async () => {
        const streamUserId = await createTestUser();
        const matchId = "900000105";

        await processGsiPayloadForMatch(streamUserId, heroSelectionTick(56, matchId));
        await processGsiPayloadForMatch(streamUserId, postGameTick(56, "loss", { matchId }));
        await processGsiPayloadForMatch(streamUserId, postGameTick(56, "loss", { matchId }));

        let rows = await getMatchRows(streamUserId);
        expect(rows[0].state).toBe("finalized");
        expect(rows[0].hero_id).toBe(56);
        const sessionAfterFirstFinalize = await getActiveSession(streamUserId);
        expect(sessionAfterFirstFinalize.last_hero_id).toBe(56);

        // Поздний повторный тик с ТЕМ ЖЕ match_id, но другим hero_id - GSI
        // продолжает слать что-то на уже отыгранный лобби/matchid. match_key
        // ("gsi:<matchId>") совпадает с уже finalized строкой -
        // ON CONFLICT DO NOTHING в createMatch не создаёт вторую строку, а
        // findActiveMatch не находит finalized строку как активную, поэтому
        // обновлять всё равно нечего.
        await processGsiPayloadForMatch(streamUserId, heroSelectionTick(70, matchId));

        rows = await getMatchRows(streamUserId);
        expect(rows).toHaveLength(1);
        expect(rows[0].match_id).toBe(matchId);
        expect(rows[0].state).toBe("finalized");
        expect(rows[0].hero_id).toBe(56);

        const sessionAfter = await getActiveSession(streamUserId);
        expect(sessionAfter.last_hero_id).toBe(56);
    });

    it("last_hero_id never updates from draft picks - only from a finalized match's final hero", async () => {
        const streamUserId = await createTestUser();
        const matchId = "900000106";

        await getOrCreateActiveSession(streamUserId);
        const before = await getActiveSession(streamUserId);
        expect(before.last_hero_id).toBeNull();

        await processGsiPayloadForMatch(streamUserId, heroSelectionTick(60, matchId));
        let session = await getActiveSession(streamUserId);
        expect(session.last_hero_id).toBeNull();

        // Смена героя посреди драфта - всё ещё не должна трогать
        // last_hero_id, матч ещё не завершён.
        await processGsiPayloadForMatch(streamUserId, heroSelectionTick(70, matchId));
        session = await getActiveSession(streamUserId);
        expect(session.last_hero_id).toBeNull();

        await processGsiPayloadForMatch(streamUserId, inProgressTick(70, { matchId }));
        session = await getActiveSession(streamUserId);
        expect(session.last_hero_id).toBeNull();

        await processGsiPayloadForMatch(streamUserId, postGameTick(70, "win", { matchId }));
        session = await getActiveSession(streamUserId);
        expect(session.last_hero_id).toBeNull(); // ещё post_game_pending, не finalized

        await processGsiPayloadForMatch(streamUserId, postGameTick(70, "win", { matchId }));
        session = await getActiveSession(streamUserId);
        expect(session.last_hero_id).toBe(70); // только теперь, при финализации
    });

    it("a match interrupted before it truly starts never records a provisional hero as last played", async () => {
        const streamUserId = await createTestUser();
        await getOrCreateActiveSession(streamUserId);
        const before = await getActiveSession(streamUserId);

        await processGsiPayloadForMatch(streamUserId, heroSelectionTick(61, "900000107"));
        let rows = await getMatchRows(streamUserId);
        expect(rows).toHaveLength(1);
        expect(rows[0].hero_id).toBe(61);

        // Разрыв до начала игры - матч остаётся interrupted навсегда
        // (companion/Dota больше не шлют payload).
        await processGsiPayloadForMatch(streamUserId, mainMenuTick());
        rows = await getMatchRows(streamUserId);
        expect(rows[0].state).toBe("interrupted");
        expect(rows[0].finalized_at).toBeNull();

        const after = await getActiveSession(streamUserId);
        expect(after.last_hero_id).toBe(before.last_hero_id);
        expect(after.last_hero_id).toBeNull();
    });

    it("fallback without match_id: hero swap during a continuous, uninterrupted draft stays one row", async () => {
        const streamUserId = await createTestUser();

        // Ни одного match_id за весь тест - только hero_id, команда и
        // непрерывность (см. задачу "Fallback без match_id"): hero_id сам
        // по себе не может быть идентичностью, но раз разрыва не было,
        // продолжающийся hero-selection того же драфта не повод заводить
        // новую строку.
        await processGsiPayloadForMatch(streamUserId, heroSelectionTick(80));
        let rows = await getMatchRows(streamUserId);
        expect(rows).toHaveLength(1);
        const matchRowId = rows[0].id;
        expect(rows[0].hero_id).toBe(80);

        await processGsiPayloadForMatch(streamUserId, heroSelectionTick(81));
        rows = await getMatchRows(streamUserId);
        expect(rows).toHaveLength(1);
        expect(rows[0].id).toBe(matchRowId);
        expect(rows[0].hero_id).toBe(81);

        await processGsiPayloadForMatch(streamUserId, strategyTimeTick(82));
        rows = await getMatchRows(streamUserId);
        expect(rows).toHaveLength(1);
        expect(rows[0].id).toBe(matchRowId);
        expect(rows[0].hero_id).toBe(82);

        await processGsiPayloadForMatch(streamUserId, postGameTick(82, "win"));
        await processGsiPayloadForMatch(streamUserId, postGameTick(82, "win"));

        rows = await getMatchRows(streamUserId);
        expect(rows).toHaveLength(1);
        expect(rows[0].id).toBe(matchRowId);
        expect(rows[0].hero_id).toBe(82);
        expect(rows[0].state).toBe("finalized");
    });

    it("existing protection is not weakened: after a real interruption, reappearing hero-selection is still a new match", async () => {
        const streamUserId = await createTestUser();

        await processGsiPayloadForMatch(streamUserId, heroSelectionTick(90)); // no matchId
        let rows = await getMatchRows(streamUserId);
        expect(rows).toHaveLength(1);
        const oldMatchId = rows[0].id;

        // Настоящий разрыв связи.
        await processGsiPayloadForMatch(streamUserId, mainMenuTick());
        rows = await getMatchRows(streamUserId);
        expect(rows[0].state).toBe("interrupted");

        // После разрыва снова hero-selection (даже на другом герое) -
        // надёжный сигнал именно НОВОГО матча, а не реконнекта.
        await processGsiPayloadForMatch(streamUserId, heroSelectionTick(91));

        rows = await getMatchRows(streamUserId);
        expect(rows).toHaveLength(2);
        const oldMatch = rows.find((row) => row.id === oldMatchId)!;
        const newMatch = rows.find((row) => row.id !== oldMatchId)!;
        expect(oldMatch.state).toBe("needs_review");
        expect(newMatch.hero_id).toBe(91);
        expect(newMatch.state).toBe("in_progress");
    });

    it("manual resolution of needs_review uses the last observed hero for last_hero_id, when it is the session's latest match", async () => {
        const streamUserId = await createTestUser();

        await processGsiPayloadForMatch(streamUserId, heroSelectionTick(63, "900000108"));
        // Ре-пик на другого героя посреди драфта, до конфликта результата.
        await processGsiPayloadForMatch(streamUserId, heroSelectionTick(64, "900000108"));
        await processGsiPayloadForMatch(streamUserId, postGameTick(64, "win", { matchId: "900000108" }));
        // Конфликтующее наблюдение -> needs_review.
        await processGsiPayloadForMatch(streamUserId, postGameTick(64, "loss", { matchId: "900000108" }));

        const rows = await getMatchRows(streamUserId);
        expect(rows).toHaveLength(1);
        expect(rows[0].state).toBe("needs_review");
        expect(rows[0].hero_id).toBe(64);

        const resolved = await correctStreamMatch(streamUserId, rows[0].id.toString(), { result: "win" });
        expect(resolved.match.state).toBe("finalized");
        expect(resolved.match.heroId).toBe(64);
        expect(resolved.session?.lastHeroId).toBe(64);
    });
});

describe("manual ranked/unranked match correction", () => {
    it("rebuilds two real-world unranked rows into an idempotent +25/-25 rating chain", async () => {
        const streamUserId = await createTestUser();
        await setGameMode(streamUserId, "unranked");
        await getOrCreateActiveSession(streamUserId);
        await setSessionRating(streamUserId, 7027);

        await processGsiPayloadForMatch(streamUserId, heroSelectionTick(36, "8917363570"));
        await processGsiPayloadForMatch(
            streamUserId,
            postGameTick(36, "win", {
                matchId: "8917363570",
                kills: 15,
                deaths: 5,
                assists: 7,
            })
        );
        await processGsiPayloadForMatch(
            streamUserId,
            postGameTick(36, "win", {
                matchId: "8917363570",
                kills: 15,
                deaths: 5,
                assists: 7,
            })
        );

        await processGsiPayloadForMatch(streamUserId, heroSelectionTick(36, "8917396565"));
        await processGsiPayloadForMatch(
            streamUserId,
            postGameTick(36, "loss", {
                matchId: "8917396565",
                kills: 8,
                deaths: 7,
                assists: 7,
            })
        );
        await processGsiPayloadForMatch(
            streamUserId,
            postGameTick(36, "loss", {
                matchId: "8917396565",
                kills: 8,
                deaths: 7,
                assists: 7,
            })
        );

        let rows = await getMatchRows(streamUserId);
        expect(rows.map((row) => row.is_ranked)).toEqual([false, false]);
        expect((await getActiveSession(streamUserId)).rating).toBe(7027);

        await correctStreamMatch(streamUserId, rows[0].id.toString(), {
            isRanked: true,
            ratingDelta: 25,
        });
        await correctStreamMatch(streamUserId, rows[1].id.toString(), {
            isRanked: true,
            ratingDelta: -25,
        });

        rows = await getMatchRows(streamUserId);
        expect(rows[0]).toMatchObject({
            is_ranked: true,
            mode_source: "manual_correction",
            result: "win",
            rating_before: 7027,
            rating_delta: 25,
            rating_after: 7052,
        });
        expect(rows[1]).toMatchObject({
            is_ranked: true,
            mode_source: "manual_correction",
            result: "loss",
            rating_before: 7052,
            rating_delta: -25,
            rating_after: 7027,
        });
        expect(await getActiveSession(streamUserId)).toMatchObject({
            rating: 7027,
            wins: 1,
            losses: 1,
        });

        await correctStreamMatch(streamUserId, rows[0].id.toString(), {
            isRanked: true,
            ratingDelta: 25,
        });
        await correctStreamMatch(streamUserId, rows[1].id.toString(), {
            isRanked: true,
            ratingDelta: -25,
        });
        await Promise.all([
            correctStreamMatch(streamUserId, rows[0].id.toString(), {
                isRanked: true,
                ratingDelta: 25,
            }),
            correctStreamMatch(streamUserId, rows[0].id.toString(), {
                isRanked: true,
                ratingDelta: 25,
            }),
        ]);
        expect(await getActiveSession(streamUserId)).toMatchObject({
            rating: 7027,
            wins: 1,
            losses: 1,
        });

        const gameMode = await pool.query<{ game_mode: string }>(
            "SELECT game_mode FROM stream_users WHERE id = $1",
            [streamUserId]
        );
        expect(gameMode.rows[0].game_mode).toBe("unranked");
    });

    it("ranked -> unranked removes its delta and rebuilds later ranked rows", async () => {
        const streamUserId = await createTestUser();
        await getOrCreateActiveSession(streamUserId);
        await setSessionRating(streamUserId, 5000);

        for (const matchId of ["900001001", "900001002"]) {
            await processGsiPayloadForMatch(streamUserId, heroSelectionTick(36, matchId));
            await processGsiPayloadForMatch(streamUserId, postGameTick(36, "win", { matchId }));
            await processGsiPayloadForMatch(streamUserId, postGameTick(36, "win", { matchId }));
        }
        await setGameMode(streamUserId, "unranked");
        await processGsiPayloadForMatch(streamUserId, heroSelectionTick(36, "900001003"));
        await processGsiPayloadForMatch(
            streamUserId,
            postGameTick(36, "loss", { matchId: "900001003" })
        );
        await processGsiPayloadForMatch(
            streamUserId,
            postGameTick(36, "loss", { matchId: "900001003" })
        );
        let rows = await getMatchRows(streamUserId);
        expect((await getActiveSession(streamUserId)).rating).toBe(5050);

        await correctStreamMatch(streamUserId, rows[0].id.toString(), { isRanked: false });
        rows = await getMatchRows(streamUserId);
        expect(rows[0]).toMatchObject({
            is_ranked: false,
            mode_source: "manual_correction",
            rating_before: null,
            rating_delta: null,
            rating_after: null,
        });
        expect(rows[1]).toMatchObject({
            rating_before: 5000,
            rating_delta: 25,
            rating_after: 5025,
        });
        expect(rows[2]).toMatchObject({
            is_ranked: false,
            rating_before: null,
            rating_delta: null,
            rating_after: null,
            result: "loss",
        });
        expect((await getActiveSession(streamUserId)).rating).toBe(5025);

        await correctStreamMatch(streamUserId, rows[1].id.toString(), {
            ratingDelta: 30,
        });
        rows = await getMatchRows(streamUserId);
        expect(rows[1]).toMatchObject({
            result: "win",
            rating_before: 5000,
            rating_delta: 30,
            rating_after: 5030,
        });
        expect(rows[2].rating_delta).toBeNull();
        expect((await getActiveSession(streamUserId)).rating).toBe(5030);
    });
});
