import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { randomUUID } from "crypto";
import { app } from "../app.js";
import { pool } from "../db/client.js";
import { createTables } from "../db/migrate.js";
import { regenerateCompanionToken } from "../services/stream-user-service.js";

// WK-121 - proves the companion-token favorite-heroes route reads/writes the
// SAME stream_queue_settings row the web cabinet's JWT-authenticated
// /account/me/queue-settings already owns (see companion.ts controller's doc
// comment) - not a second favorites store.
const suffix = `${Date.now()}-companion-favorite-heroes`;
const email = `stream_companion_favorite_heroes_${suffix}@example.com`;
const publicToken = randomUUID();

let streamUserId: number;
let companionToken: string;
let jwtToken: string;

beforeAll(async () => {
    await createTables();

    const hashed = await bcrypt.hash("test-password-123", 10);
    const userResult = await pool.query(
        `INSERT INTO stream_users (email, password_hash, public_token) VALUES ($1, $2, $3) RETURNING id`,
        [email, hashed, publicToken]
    );
    streamUserId = userResult.rows[0].id;

    const regenerated = await regenerateCompanionToken(streamUserId.toString());
    companionToken = regenerated!.token;

    jwtToken = jwt.sign(
        { streamUserId: streamUserId.toString() },
        process.env.STREAM_JWT_SECRET!,
        { expiresIn: "5m" }
    );
});

afterAll(async () => {
    await pool.query("DELETE FROM stream_users WHERE id = $1", [streamUserId]);
    await pool.end();
});

describe("GET/PUT /api/stream/companion/favorite-heroes", () => {
    it("requires a companion token", async () => {
        expect((await request(app).get("/api/stream/companion/favorite-heroes")).status).toBe(401);
        expect(
            (await request(app).put("/api/stream/companion/favorite-heroes").send({ favoriteHeroIds: [1] })).status
        ).toBe(401);
    });

    it("starts empty", async () => {
        const res = await request(app)
            .get("/api/stream/companion/favorite-heroes")
            .set("Authorization", `Bearer ${companionToken}`);
        expect(res.status).toBe(200);
        expect(res.body.favoriteHeroIds).toEqual([]);
    });

    it("rejects more than 3 heroes", async () => {
        const res = await request(app)
            .put("/api/stream/companion/favorite-heroes")
            .set("Authorization", `Bearer ${companionToken}`)
            .send({ favoriteHeroIds: [1, 2, 3, 4] });
        expect(res.status).toBe(400);
    });

    it("saves favorites via the companion token and reads them back", async () => {
        const put = await request(app)
            .put("/api/stream/companion/favorite-heroes")
            .set("Authorization", `Bearer ${companionToken}`)
            .send({ favoriteHeroIds: [14, 74] });
        expect(put.status).toBe(200);
        expect(put.body.favoriteHeroIds).toEqual([14, 74]);

        const get = await request(app)
            .get("/api/stream/companion/favorite-heroes")
            .set("Authorization", `Bearer ${companionToken}`);
        expect(get.body.favoriteHeroIds).toEqual([14, 74]);
    });

    it("is the SAME row the web JWT-authenticated queue-settings endpoint sees", async () => {
        const viaWeb = await request(app)
            .get("/api/stream/account/me/queue-settings")
            .set("Authorization", `Bearer ${jwtToken}`);
        expect(viaWeb.status).toBe(200);
        expect(viaWeb.body.favoriteHeroIds).toEqual([14, 74]);

        // Writing through the web JWT path is visible through the companion
        // route too - one row, two credentials.
        await request(app)
            .put("/api/stream/account/me/queue-settings")
            .set("Authorization", `Bearer ${jwtToken}`)
            .send({ favoriteHeroIds: [1] });

        const viaCompanion = await request(app)
            .get("/api/stream/companion/favorite-heroes")
            .set("Authorization", `Bearer ${companionToken}`);
        expect(viaCompanion.body.favoriteHeroIds).toEqual([1]);
    });

    it("PUT does not disturb the rest of the web-only queue settings blob (visibility/widgets)", async () => {
        const before = await request(app)
            .get("/api/stream/account/me/queue-settings")
            .set("Authorization", `Bearer ${jwtToken}`);

        await request(app)
            .put("/api/stream/companion/favorite-heroes")
            .set("Authorization", `Bearer ${companionToken}`)
            .send({ favoriteHeroIds: [2] });

        const after = await request(app)
            .get("/api/stream/account/me/queue-settings")
            .set("Authorization", `Bearer ${jwtToken}`);

        expect(after.body.favoriteHeroIds).toEqual([2]);
        expect(after.body.visibility).toEqual(before.body.visibility);
        expect(after.body.widgets).toEqual(before.body.widgets);
    });
});
