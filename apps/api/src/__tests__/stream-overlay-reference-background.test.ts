import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import { randomUUID } from "crypto";
import fs from "fs";
import path from "path";
import sharp from "sharp";
import { app } from "../app.js";
import { env } from "../config/env.js";
import { pool } from "../db/client.js";
import { createTables } from "../db/migrate.js";

const suffix = `${Date.now()}-ref-bg`;
const email = `stream_ref_bg_${suffix}@example.com`;

const uploadsDir = path.join(process.cwd(), "uploads");
const endpoint = "/api/stream/account/me/overlay-reference-background";

let streamUserId: number;
let streamToken: string;

const filenamesToCleanup: string[] = [];

const makePng = (width: number, height: number) =>
    sharp({
        create: {
            width,
            height,
            channels: 3,
            background: { r: 10, g: 200, b: 50 },
        },
    })
        .png()
        .toBuffer();

beforeAll(async () => {
    await createTables();

    const hashed = await bcrypt.hash("test-password-123", 10);
    const result = await pool.query(
        `INSERT INTO stream_users (email, password_hash, public_token) VALUES ($1, $2, $3) RETURNING id`,
        [email, hashed, randomUUID()]
    );
    streamUserId = result.rows[0].id;

    streamToken = jwt.sign({ streamUserId: streamUserId.toString() }, env.streamJwtSecret, {
        expiresIn: "1h",
    });
});

afterAll(async () => {
    for (const filename of filenamesToCleanup) {
        const filePath = path.join(uploadsDir, filename);
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    }
    await pool.query("DELETE FROM stream_users WHERE id = $1", [streamUserId]);
    await pool.end();
});

describe("stream overlay reference background", () => {
    it("rejects anonymous access", async () => {
        const res = await request(app).get(endpoint);
        expect(res.status).toBe(401);
    });

    it("returns null when nothing was uploaded yet", async () => {
        const res = await request(app)
            .get(endpoint)
            .set("Authorization", `Bearer ${streamToken}`);
        expect(res.status).toBe(200);
        expect(res.body).toBeNull();
    });

    it("uploads, recodes to WebP, caps dimensions and never enlarges", async () => {
        const png = await makePng(20, 10);

        const res = await request(app)
            .post(endpoint)
            .set("Authorization", `Bearer ${streamToken}`)
            .attach("image", png, "hud.png");

        expect(res.status).toBe(200);
        expect(res.body.fileName).toMatch(/^[a-f0-9]{32}\.webp$/);
        expect(res.body.naturalWidth).toBe(20);
        expect(res.body.naturalHeight).toBe(10);
        expect(res.body.opacity).toBeCloseTo(0.7);
        expect(res.body.url).toBe(`/uploads/${res.body.fileName}`);

        filenamesToCleanup.push(res.body.fileName);
        expect(fs.existsSync(path.join(uploadsDir, res.body.fileName))).toBe(true);
    });

    it("replacing the image deletes the previous file", async () => {
        const first = await request(app)
            .post(endpoint)
            .set("Authorization", `Bearer ${streamToken}`)
            .attach("image", await makePng(30, 20), "first.png");
        const firstFilename = first.body.fileName;
        filenamesToCleanup.push(firstFilename);

        const second = await request(app)
            .post(endpoint)
            .set("Authorization", `Bearer ${streamToken}`)
            .attach("image", await makePng(40, 25), "second.png");
        filenamesToCleanup.push(second.body.fileName);

        expect(second.body.fileName).not.toBe(firstFilename);
        expect(fs.existsSync(path.join(uploadsDir, firstFilename))).toBe(false);
        expect(fs.existsSync(path.join(uploadsDir, second.body.fileName))).toBe(true);
    });

    it("patches opacity without touching the file", async () => {
        const res = await request(app)
            .patch(endpoint)
            .set("Authorization", `Bearer ${streamToken}`)
            .send({ opacity: 0.35 });

        expect(res.status).toBe(200);
        expect(res.body.opacity).toBeCloseTo(0.35);
    });

    it("rejects an out-of-range opacity", async () => {
        const res = await request(app)
            .patch(endpoint)
            .set("Authorization", `Bearer ${streamToken}`)
            .send({ opacity: 1.5 });

        expect(res.status).toBe(400);
    });

    it("rejects a fake image signature", async () => {
        const res = await request(app)
            .post(endpoint)
            .set("Authorization", `Bearer ${streamToken}`)
            .attach("image", Buffer.from("not an image"), "fake.png");

        expect(res.status).toBe(415);
    });

    it("deletes the record and the file on disk", async () => {
        const before = await request(app)
            .get(endpoint)
            .set("Authorization", `Bearer ${streamToken}`);
        const filename = before.body.fileName;

        const res = await request(app)
            .delete(endpoint)
            .set("Authorization", `Bearer ${streamToken}`);
        expect(res.status).toBe(204);

        expect(fs.existsSync(path.join(uploadsDir, filename))).toBe(false);

        const after = await request(app)
            .get(endpoint)
            .set("Authorization", `Bearer ${streamToken}`);
        expect(after.body).toBeNull();
    });
});
