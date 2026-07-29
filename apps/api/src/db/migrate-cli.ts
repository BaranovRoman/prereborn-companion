import { pool } from "./client.js";
import { createTables } from "./migrate.js";

try {
    await createTables();
    console.log("PreReborn database migration completed");
} finally {
    await pool.end();
}
