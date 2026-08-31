import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { randomUUID } from "crypto";
import { app } from "../app.js";
import { pool } from "../db/client.js";
import { createTables } from "../db/migrate.js";
import { regenerateCompanionToken } from "../services/stream-user-service.js";

// WK-122 §19 - proves the companion-scoped overlay-layout route reads/writes
// the SAME stream_overlay_settings row the web cabinet's JWT-authenticated
// /account/me/overlay-layout already owns - closing the gap WK-121 left
// open (local overlay renderer/editor had no access to the saved layout at
// all, only fixed default widget positions). Unlike favorite-heroes, this
// reuses the exact same controllers (no narrowed wire shape) since
// Companion needs the full layout to render accurately.
const suffix = `${Date.now()}-companion-overlay-layout`;
const email = `stream_companion_overlay_layout_${suffix}@example.com`;
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

describe("GET/PUT /api/stream/companion/overlay-layout", () => {
    it("requires a companion token or session", async () => {
        expect((await request(app).get("/api/stream/companion/overlay-layout")).status).toBe(401);
        expect((await request(app).put("/api/stream/companion/overlay-layout").send({})).status).toBe(401);
    });

    it("returns the default layout before anything is saved", async () => {
        const res = await request(app)
            .get("/api/stream/companion/overlay-layout")
            .set("Authorization", `Bearer ${companionToken}`);
        expect(res.status).toBe(200);
        expect(res.body.version).toBe(5);
        expect(res.body.scenes.gameplay.widgets.session.anchor).toBe("top-left");
    });

    it("also accepts a stream-user session JWT (Companion login, not just the legacy token)", async () => {
        const res = await request(app)
            .get("/api/stream/companion/overlay-layout")
            .set("Authorization", `Bearer ${jwtToken}`);
        expect(res.status).toBe(200);
        expect(res.body.version).toBe(5);
    });

    it("saves a layout via the companion token and reads it back", async () => {
        const put = await request(app)
            .put("/api/stream/companion/overlay-layout")
            .set("Authorization", `Bearer ${companionToken}`)
            .send({
                scenes: {
                    gameplay: {
                        widgets: {
                            session: { xVw: 10, yVh: 20, scale: 1.2, visible: true, anchor: "bottom-right" },
                        },
                    },
                },
            });
        expect(put.status).toBe(200);
        expect(put.body.scenes.gameplay.widgets.session.xVw).toBe(10);
        expect(put.body.scenes.gameplay.widgets.session.anchor).toBe("bottom-right");

        const get = await request(app)
            .get("/api/stream/companion/overlay-layout")
            .set("Authorization", `Bearer ${companionToken}`);
        expect(get.body.scenes.gameplay.widgets.session.xVw).toBe(10);
    });

    it("is the SAME row the web JWT-authenticated overlay-layout endpoint sees - one editor, one truth", async () => {
        const viaWeb = await request(app)
            .get("/api/stream/account/me/overlay-layout")
            .set("Authorization", `Bearer ${jwtToken}`);
        expect(viaWeb.status).toBe(200);
        expect(viaWeb.body.scenes.gameplay.widgets.session.xVw).toBe(10);

        // Writing through the web JWT path is visible through the companion
        // route too.
        await request(app)
            .put("/api/stream/account/me/overlay-layout")
            .set("Authorization", `Bearer ${jwtToken}`)
            .send({
                scenes: {
                    gameplay: {
                        widgets: {
                            session: { xVw: 55, yVh: 60, scale: 1, visible: false, anchor: "top-left" },
                        },
                    },
                },
            });

        const viaCompanion = await request(app)
            .get("/api/stream/companion/overlay-layout")
            .set("Authorization", `Bearer ${companionToken}`);
        expect(viaCompanion.body.scenes.gameplay.widgets.session.xVw).toBe(55);
        expect(viaCompanion.body.scenes.gameplay.widgets.session.visible).toBe(false);
    });
});
