import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "crypto";
import bcrypt from "bcryptjs";
import { pool } from "../db/client.js";
import { createTables } from "../db/migrate.js";
import {
    __setChatClientFactoryForTests,
    disconnectTwitch,
    getTwitchChatStatus,
    saveTwitchLink,
} from "../services/twitch-integration-service.js";
import { TwitchEventSubChatClient, TwitchSubscribeError, type EventSubSocket } from "../services/twitch-eventsub-chat.js";

// WK-65/66 added Twitch chat via EventSub + the user:read:chat scope. Links
// created before that scope existed carry a token that authenticates fine
// but can't subscribe to chat - this file proves the status endpoint
// surfaces that as reauth_required (not an endless "reconnecting"), and
// that the existing disconnect/reconnect OAuth flow clears it again.

class FakeSocket implements EventSubSocket {
    private listeners = new Map<string, Array<(payload?: unknown) => void>>();
    closed = false;
    on(event: string, listener: (payload?: unknown) => void) {
        this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
    }
    emit(event: string, payload?: unknown) {
        for (const listener of this.listeners.get(event) ?? []) listener(payload);
    }
    close() {
        this.closed = true;
        this.emit("close");
    }
}
const welcome = (id: string) => JSON.stringify({
    metadata: { message_type: "session_welcome" },
    payload: { session: { id, keepalive_timeout_seconds: 30 } },
});
// No real timer should ever need to fire in this test - state transitions
// are driven directly by emitting socket events and flushing microtasks.
const noopSetTimer = (() => 0) as unknown as typeof setTimeout;
const noopClearTimer = (() => undefined) as unknown as typeof clearTimeout;
const flushMicrotasks = async () => {
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
};

const suffix = `${Date.now()}-twitch-integration`;
const createdUserIds: string[] = [];

const createTestUser = async (): Promise<string> => {
    const email = `stream_twitch_${suffix}_${createdUserIds.length + 1}@example.com`;
    const hashed = await bcrypt.hash("test-password-123", 10);
    const result = await pool.query<{ id: number }>(
        `INSERT INTO stream_users (email, password_hash, public_token) VALUES ($1, $2, $3) RETURNING id`,
        [email, hashed, randomUUID()]
    );
    const id = result.rows[0].id.toString();
    createdUserIds.push(id);
    return id;
};

beforeAll(async () => {
    await createTables();
});

afterAll(async () => {
    __setChatClientFactoryForTests(null);
    if (createdUserIds.length > 0) {
        await pool.query(`DELETE FROM stream_users WHERE id = ANY($1::int[])`, [createdUserIds.map(Number)]);
    }
    await pool.end();
});

describe("Twitch chat status - reauth_required flow", () => {
    it("has no Twitch link yet", async () => {
        const streamUserId = await createTestUser();
        const status = await getTwitchChatStatus(streamUserId);
        expect(status).toMatchObject({ accountConnected: false, connected: false, state: "unavailable", messages: [] });
    });

    it("surfaces reauth_required for a stale token, then clears it once the account is re-linked", async () => {
        const streamUserId = await createTestUser();
        const staleToken = "stale-secret-token-without-chat-scope";
        const freshToken = "fresh-secret-token-with-chat-scope";

        await saveTwitchLink(
            streamUserId,
            { id: `twitch-${streamUserId}`, login: "olduser", display_name: "OldUser", profile_image_url: "" },
            { access_token: staleToken, refresh_token: "stale-refresh", expires_in: 3600 }
        );

        let staleSocket: FakeSocket | null = null;
        __setChatClientFactoryForTests((options) => new TwitchEventSubChatClient({
            ...options,
            createSocket: () => { staleSocket = new FakeSocket(); return staleSocket; },
            createSubscription: async () => { throw new TwitchSubscribeError("EventSub subscription returned 401", 401); },
            validateToken: async () => ({ valid: true, scopes: ["channel:read:subscriptions"] }),
            setTimer: noopSetTimer,
            clearTimer: noopClearTimer,
        }));

        const beforeWelcome = await getTwitchChatStatus(streamUserId);
        expect(beforeWelcome).toMatchObject({ accountConnected: true, connected: false, state: "reconnecting" });

        expect(staleSocket).not.toBeNull();
        staleSocket!.emit("message", welcome("session-1"));
        await flushMicrotasks();

        const reauth = await getTwitchChatStatus(streamUserId);
        expect(reauth).toMatchObject({ accountConnected: true, connected: false, state: "reauth_required" });
        expect(JSON.stringify(reauth)).not.toContain(staleToken);

        let freshSocket: FakeSocket | null = null;
        __setChatClientFactoryForTests((options) => new TwitchEventSubChatClient({
            ...options,
            createSocket: () => { freshSocket = new FakeSocket(); return freshSocket; },
            createSubscription: async () => undefined,
            validateToken: async () => ({ valid: true, scopes: ["user:read:chat"] }),
            setTimer: noopSetTimer,
            clearTimer: noopClearTimer,
        }));

        // Re-link: same flow the OAuth callback uses (saveTwitchLink), the
        // only path a user actually has to recover a stale-scope token.
        await saveTwitchLink(
            streamUserId,
            { id: `twitch-${streamUserId}`, login: "newuser", display_name: "NewUser", profile_image_url: "" },
            { access_token: freshToken, refresh_token: "fresh-refresh", expires_in: 3600 }
        );
        expect(staleSocket!.closed).toBe(true);

        const afterRelinkBeforeWelcome = await getTwitchChatStatus(streamUserId);
        expect(afterRelinkBeforeWelcome.state).toBe("reconnecting");
        expect(freshSocket).not.toBeNull();
        expect(freshSocket).not.toBe(staleSocket);

        freshSocket!.emit("message", welcome("session-2"));
        await flushMicrotasks();

        const connected = await getTwitchChatStatus(streamUserId);
        expect(connected).toMatchObject({ accountConnected: true, connected: true, state: "connected", displayName: "NewUser" });
        expect(JSON.stringify(connected)).not.toContain(freshToken);
        expect(JSON.stringify(connected)).not.toContain(staleToken);

        await disconnectTwitch(streamUserId);
    });
});
