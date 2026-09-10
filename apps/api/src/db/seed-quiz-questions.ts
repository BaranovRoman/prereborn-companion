import { pool } from "./client.js";

// WK-116 - hand-curated v1 question bank. Text-only (`assetUrl: null`)
// deliberately: icon-based categories (ability by icon, item by icon) need
// verified-working CDN asset URLs per question, which is real content
// production work independent of the round/scoring architecture this phase
// delivers - adding more rows (icon-backed or not) later is a pure content
// change, never a schema change, per quiz_questions/quiz_question_options'
// shape. Options are listed with the correct one flagged inline, not
// pre-shuffled - `pickRandomQuestion` in quiz-round-service.ts reads them
// in `position` order but the UI is expected to randomize presentation
// order itself if that's ever needed; v1 doesn't.
interface SeedQuestion {
    category: string;
    prompt: string;
    options: Array<{ label: string; correct?: true }>;
}

const SEED_QUESTIONS: SeedQuestion[] = [
    {
        category: "ПРЕДМЕТ",
        prompt: "Какой предмет усиливает регенерацию маны сильнее всего?",
        options: [
            { label: "Arcane Boots", correct: true },
            { label: "Power Treads" },
            { label: "Aether Lens" },
            { label: "Boots of Travel" },
        ],
    },
    {
        category: "ПРЕДМЕТ",
        prompt: "Из каких двух предметов собирается Vladmir's Offering?",
        options: [
            { label: "Ring of Basilius + Void Stone + Recipe", correct: true },
            { label: "Ring of Regen + Circlet + Recipe" },
            { label: "Broadsword + Vitality Booster + Recipe" },
            { label: "Robe of the Magi + Circlet + Recipe" },
        ],
    },
    {
        category: "COOLDOWN",
        prompt: "Какой базовый кулдаун у BKB (Black King Bar)?",
        options: [
            { label: "70 секунд" },
            { label: "85 секунд" },
            { label: "80 секунд", correct: true },
            { label: "60 секунд" },
        ],
    },
    {
        category: "MANA COST",
        prompt: "Сколько маны стоит третий уровень Laguna Blade (Lion)?",
        options: [
            { label: "150" },
            { label: "200", correct: true },
            { label: "250" },
            { label: "180" },
        ],
    },
    {
        category: "AGHANIM SCEPTER",
        prompt: "Что даёт Aghanim's Scepter герою Io?",
        options: [
            { label: "Дополнительное заклинание Relocate", correct: true },
            { label: "Второй Tether" },
            { label: "Невидимость" },
            { label: "Увеличенный радиус Overcharge" },
        ],
    },
    {
        category: "AGHANIM SHARD",
        prompt: "Что даёт Aghanim's Shard герою Snapfire?",
        options: [
            { label: "Экран дыма (Mortimer Kisses AoE)" },
            { label: "Lil' Shredder — пассивный урон по area", correct: true },
            { label: "Дополнительный прыжок Cookie" },
            { label: "Уменьшенный кулдаун Firesnap Cookie" },
        ],
    },
    {
        category: "ГЕРОЙ",
        prompt: "Какой герой имеет способность Chronosphere?",
        options: [
            { label: "Faceless Void", correct: true },
            { label: "Chronos" },
            { label: "Rubick" },
            { label: "Dark Seer" },
        ],
    },
    {
        category: "ПРЕДМЕТ",
        prompt: "Какой предмет даёт пассивную способность True Strike (иммунитет к промаху от эвейжна)?",
        options: [
            { label: "Monkey King Bar", correct: true },
            { label: "Mjollnir" },
            { label: "Daedalus" },
            { label: "Silver Edge" },
        ],
    },
];

// Idempotent - safe to call on every startup (same convention as
// createTables). Only inserts when the table is empty, so an operator who
// has already hand-edited/extended the bank never gets it silently
// overwritten by a redeploy.
export const seedQuizQuestions = async (): Promise<void> => {
    const existing = await pool.query<{ count: string }>(
        "SELECT COUNT(*)::text AS count FROM quiz_questions"
    );
    if (Number(existing.rows[0].count) > 0) return;

    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        for (const question of SEED_QUESTIONS) {
            const inserted = await client.query<{ id: number }>(
                `INSERT INTO quiz_questions (category, prompt) VALUES ($1, $2) RETURNING id`,
                [question.category, question.prompt]
            );
            const questionId = inserted.rows[0].id;
            for (const [position, option] of question.options.entries()) {
                await client.query(
                    `INSERT INTO quiz_question_options (question_id, position, label, is_correct)
                     VALUES ($1, $2, $3, $4)`,
                    [questionId, position, option.label, option.correct === true]
                );
            }
        }
        await client.query("COMMIT");
    } catch (error) {
        await client.query("ROLLBACK");
        throw error;
    } finally {
        client.release();
    }
};
