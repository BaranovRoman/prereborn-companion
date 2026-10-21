import { describe, expect, it } from "vitest";
import {
    clampClipDuration,
    classifyCreateClipStatus,
    createClipForBroadcaster,
    hasClipsScope,
    type ClipDeps,
} from "../services/twitch-clips-service.js";

// WK-178 - Create Clip + Get Clips confirmation, driven by a scripted fake
// fetch and a virtual clock (no network, no DB, no real waiting).

type Step = { status: number; body?: unknown } | Error;

const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body ?? {}), { status, headers: { "Content-Type": "application/json" } });

const fakeTwitch = (create: Step, lookups: Step[] = []) => {
    const calls: Array<{ method: string; url: URL }> = [];
    let clock = 0;
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(input));
        const method = init?.method ?? "GET";
        calls.push({ method, url });
        const step = method === "POST" ? create : lookups.shift() ?? { status: 200, body: { data: [] } };
        if (step instanceof Error) throw step;
        return json(step.status, step.body);
    }) as typeof fetch;
    const deps: Partial<ClipDeps> = {
        fetch: fetchImpl,
        sleep: async (ms) => { clock += ms; },
        now: () => clock,
        pollIntervalMs: 1_000,
        pollTimeoutMs: 15_000,
    };
    return { calls, deps };
};

const input = { broadcasterId: "1234", accessToken: "user-token", clientId: "client" };
const accepted = { status: 202, body: { data: [{ id: "Clip1", edit_url: "https://clips.twitch.tv/Clip1/edit" }] } };
const ready = {
    status: 200,
    body: {
        data: [{
            id: "Clip1",
            url: "https://clips.twitch.tv/Clip1",
            title: "Rampage",
            duration: 30,
            created_at: "2026-10-21T10:00:00Z",
            thumbnail_url: "https://thumb",
        }],
    },
};

describe("createClipForBroadcaster", () => {
    it("creates a 30 s clip by default and returns it once Get Clips confirms it", async () => {
        const { calls, deps } = fakeTwitch(accepted, [{ status: 200, body: { data: [] } }, ready]);
        const result = await createClipForBroadcaster(input, deps);
        expect(result).toEqual({
            ok: true,
            clip: {
                id: "Clip1",
                url: "https://clips.twitch.tv/Clip1",
                editUrl: "https://clips.twitch.tv/Clip1/edit",
                title: "Rampage",
                durationSeconds: 30,
                createdAt: "2026-10-21T10:00:00Z",
                thumbnailUrl: "https://thumb",
            },
        });
        const create = calls[0];
        expect(create.method).toBe("POST");
        expect(create.url.searchParams.get("broadcaster_id")).toBe("1234");
        expect(create.url.searchParams.get("duration")).toBe("30.0");
        expect(calls.slice(1).every(({ url }) => url.searchParams.get("id") === "Clip1")).toBe(true);
    });

    it("passes a custom duration through, clamped to Twitch's 5..60 s range", async () => {
        const { calls, deps } = fakeTwitch(accepted, [ready]);
        await createClipForBroadcaster({ ...input, durationSeconds: 45 }, deps);
        expect(calls[0].url.searchParams.get("duration")).toBe("45.0");
        expect(clampClipDuration(2)).toBe(5);
        expect(clampClipDuration(90)).toBe(60);
        expect(clampClipDuration(12.34)).toBe(12.3);
        expect(clampClipDuration(undefined)).toBe(30);
    });

    it.each([
        [404, "not_live"],
        [403, "clips_restricted"],
        [401, "reauth_required"],
        [400, "clip_rejected"],
        [429, "rate_limited"],
        [503, "twitch_unavailable"],
    ] as const)("maps Create Clip HTTP %i to %s without polling", async (status, code) => {
        const { calls, deps } = fakeTwitch({ status, body: { message: "nope" } });
        const result = await createClipForBroadcaster(input, deps);
        expect(result).toMatchObject({ ok: false, code });
        if (!result.ok) expect(result.message.length).toBeGreaterThan(0);
        expect(calls).toHaveLength(1);
    });

    it("reports twitch_unavailable when Twitch can't be reached", async () => {
        const { deps } = fakeTwitch(new Error("ECONNRESET"));
        expect(await createClipForBroadcaster(input, deps)).toMatchObject({ ok: false, code: "twitch_unavailable" });
    });

    it("reports clip_failed when Twitch accepted the request but the clip never appears", async () => {
        const { calls, deps } = fakeTwitch(accepted, []);
        const result = await createClipForBroadcaster(input, deps);
        expect(result).toMatchObject({ ok: false, code: "clip_failed" });
        // Bounded by the 15 s window at a 1 s interval.
        expect(calls.length - 1).toBe(15);
    });

    it("keeps polling through a transient Get Clips failure", async () => {
        const { deps } = fakeTwitch(accepted, [new Error("timeout"), { status: 500 }, ready]);
        expect(await createClipForBroadcaster(input, deps)).toMatchObject({ ok: true });
    });

    it("treats an accepted response without a clip id as a failed clip", async () => {
        const { deps } = fakeTwitch({ status: 202, body: { data: [] } });
        expect(await createClipForBroadcaster(input, deps)).toMatchObject({ ok: false, code: "clip_failed" });
    });
});

describe("clip helpers", () => {
    it("classifies only 200/202 as accepted", () => {
        expect(classifyCreateClipStatus(202)).toBeNull();
        expect(classifyCreateClipStatus(200)).toBeNull();
        expect(classifyCreateClipStatus(500)).toBe("twitch_unavailable");
    });

    it("detects the clips:edit scope, and stays unknown when validation was inconclusive", () => {
        expect(hasClipsScope({ valid: true, scopes: ["user:read:chat", "clips:edit"] })).toBe(true);
        expect(hasClipsScope({ valid: true, scopes: ["user:read:chat"] })).toBe(false);
        expect(hasClipsScope({ valid: false, scopes: [] })).toBe(false);
        expect(hasClipsScope(null)).toBeNull();
    });
});
