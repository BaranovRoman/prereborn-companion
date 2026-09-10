import { pool } from "./client.js";
import { createTables } from "./migrate.js";
import { seedQuizQuestions } from "./seed-quiz-questions.js";

try {
    await createTables();
    await seedQuizQuestions();
    console.log("PreReborn database migration completed");
} finally {
    await pool.end();
}
