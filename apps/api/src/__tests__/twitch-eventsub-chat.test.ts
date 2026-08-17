import { describe, expect, it, vi } from "vitest";
import {
    classifySubscribeFailure,
    parseChatNotification,
    reconnectDelay,
    REQUIRED_CHAT_SCOPE,
    TwitchEventSubChatClient,
    TwitchSubscribeError,
    type EventSubSocket,
    type SubscribeFailureClass,
} from "../services/twitch-eventsub-chat.js";

class FakeSocket implements EventSubSocket {
    private listeners = new Map<string, Array<(payload?: unknown) => void>>();
    closed = false;
    on(event: string, listener: (payload?: unknown) => void) {
        this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
    }
    emit(event: string, payload?: unknown) {
        for (const listener of this.listeners.get(event) ?? []) listener(payload);
    }
    close() { this.closed = true; this.emit("close"); }
}
const welcome = (id: string) => JSON.stringify({
    metadata: { message_type: "session_welcome" },
    payload: { session: { id, keepalive_timeout_seconds: 30 } },
});
const notification = JSON.stringify({
    metadata: { message_id: "delivery-1", message_type: "notification", message_timestamp: "2026-08-12T00:00:00Z" },
    payload: { subscription: { type: "channel.chat.message" }, event: {
        message_id: "message-1", chatter_user_name: "Viewer", color: "#fff",
        message_type: "text", message: { text: "hello" }, badges: [],
    } },
});

describe("Twitch EventSub chat", () => {
    it("deduplicates Twitch at-least-once deliveries", () => {
        const seen = new Set<string>();
        const value = JSON.parse(notification);
        expect(parseChatNotification(value, seen)?.text).toBe("hello");
        expect(parseChatNotification(value, seen)).toBeNull();
    });

    it("uses bounded exponential reconnect delays", () => {
        expect([0, 1, 2, 10].map(reconnectDelay)).toEqual([1000, 2000, 4000, 30000]);
    });

    it("subscribes once and reconnects without duplicate messages", async () => {
        vi.useFakeTimers();
        const sockets: FakeSocket[] = [];
        const subscriptions: string[] = [];
        const messages: string[] = [];
        const client = new TwitchEventSubChatClient({
            broadcasterId: "42", clientId: "client", getAccessToken: async () => "token",
            createSocket: () => { const socket = new FakeSocket(); sockets.push(socket); return socket; },
            createSubscription: async (sessionId) => { subscriptions.push(sessionId); },
            onMessage: (message) => messages.push(message.id),
        });
        client.start();
        sockets[0].emit("message", welcome("session-1"));
        await vi.runAllTicks();
        sockets[0].emit("message", notification);
        sockets[0].emit("message", notification);
        expect(subscriptions).toEqual(["session-1"]);
        expect(messages).toEqual(["message-1"]);

        sockets[0].close();
        await vi.advanceTimersByTimeAsync(1000);
        expect(sockets).toHaveLength(2);
        sockets[1].emit("message", welcome("session-2"));
        await vi.runAllTicks();
        sockets[1].emit("message", notification);
        expect(subscriptions).toEqual(["session-1", "session-2"]);
        expect(messages).toEqual(["message-1"]);
        client.stop();
        vi.useRealTimers();
    });

    it("uses Twitch reconnect URL without creating another subscription", async () => {
        const sockets: FakeSocket[] = [];
        const subscriptions: string[] = [];
        const client = new TwitchEventSubChatClient({
            broadcasterId: "42", clientId: "client", getAccessToken: async () => "token",
            createSocket: () => { const socket = new FakeSocket(); sockets.push(socket); return socket; },
            createSubscription: async (sessionId) => { subscriptions.push(sessionId); },
            onMessage: () => undefined,
        });
        client.start();
        sockets[0].emit("message", welcome("session-1"));
        await Promise.resolve();
        sockets[0].emit("message", JSON.stringify({
            metadata: { message_type: "session_reconnect" },
            payload: { session: { reconnect_url: "wss://reconnect" } },
        }));
        expect(sockets).toHaveLength(2);
        sockets[1].emit("message", welcome("session-2"));
        await Promise.resolve();
        expect(subscriptions).toEqual(["session-1"]);
        expect(sockets[0].closed).toBe(true);
        client.stop();
    });

    describe("classifySubscribeFailure", () => {
        const scopedValidation = { valid: true, scopes: [REQUIRED_CHAT_SCOPE] };
        const unscopedValidation = { valid: true, scopes: ["channel:read:subscriptions"] };

        it("treats a missing token as reauth_required without calling validate", async () => {
            const validateToken = vi.fn();
            const result = await classifySubscribeFailure(new TwitchSubscribeError("no token", null), null, validateToken);
            expect(result).toBe("reauth_required");
            expect(validateToken).not.toHaveBeenCalled();
        });

        it("treats non-auth HTTP statuses as transient without calling validate", async () => {
            const validateToken = vi.fn();
            const result = await classifySubscribeFailure(new TwitchSubscribeError("boom", 500), "token", validateToken);
            expect(result).toBe("transient");
            expect(validateToken).not.toHaveBeenCalled();
        });

        it("confirms reauth_required only when validate says the token lacks the chat scope", async () => {
            const result = await classifySubscribeFailure(
                new TwitchSubscribeError("forbidden", 403),
                "token",
                async () => unscopedValidation
            );
            expect(result).toBe("reauth_required");
        });

        it("confirms reauth_required when validate says the token itself is invalid", async () => {
            const result = await classifySubscribeFailure(
                new TwitchSubscribeError("unauthorized", 401),
                "token",
                async () => ({ valid: false, scopes: [] })
            );
            expect(result).toBe("reauth_required");
        });

        it("does not classify a 401/403 as reauth_required when the token already has the scope", async () => {
            const result = await classifySubscribeFailure(
                new TwitchSubscribeError("unauthorized", 401),
                "token",
                async () => scopedValidation
            );
            expect(result).toBe("transient");
        });

        it("treats an unreachable validate endpoint as transient, not reauth_required", async () => {
            const result = await classifySubscribeFailure(
                new TwitchSubscribeError("unauthorized", 401),
                "token",
                async () => null
            );
            expect(result).toBe("transient");
        });
    });

    // The reauth classification path chains several awaits (getAccessToken
    // -> subscribe -> classifySubscribeFailure -> validateToken), more hops
    // than vi.runAllTicks() (which only drains process.nextTick) reliably
    // flushes under fake timers. Drain the real microtask queue explicitly.
    const flushMicrotasks = async () => {
        for (let i = 0; i < 20; i += 1) await Promise.resolve();
    };

    describe("TwitchEventSubChatClient reauth handling", () => {
        const setup = (validateToken: (token: string) => Promise<{ valid: boolean; scopes: string[] } | null>) => {
            vi.useFakeTimers();
            const sockets: FakeSocket[] = [];
            const errors: Array<{ message: string; classification: SubscribeFailureClass }> = [];
            let subscribeAttempts = 0;
            const client = new TwitchEventSubChatClient({
                broadcasterId: "42",
                clientId: "client",
                getAccessToken: async () => "super-secret-token-value",
                createSocket: () => { const socket = new FakeSocket(); sockets.push(socket); return socket; },
                createSubscription: async () => {
                    subscribeAttempts += 1;
                    throw new TwitchSubscribeError(`EventSub subscription returned 401`, 401);
                },
                validateToken,
                onMessage: () => undefined,
                onError: (error, classification) => errors.push({
                    message: error instanceof Error ? error.message : String(error),
                    classification,
                }),
            });
            return { client, sockets, errors, attempts: () => subscribeAttempts };
        };

        it("enters reauth_required once validate confirms the scope is missing, and never leaks the token", async () => {
            const { client, sockets, errors } = setup(async () => ({ valid: true, scopes: [] }));
            client.start();
            sockets[0].emit("message", welcome("session-1"));
            await flushMicrotasks();

            expect(client.state).toBe("reauth_required");
            expect(errors).toEqual([{ message: "EventSub subscription returned 401", classification: "reauth_required" }]);
            for (const entry of errors) expect(entry.message).not.toContain("super-secret-token-value");

            client.stop();
            vi.useRealTimers();
        });

        it("never schedules another reconnect after reauth_required is reached", async () => {
            const { client, sockets } = setup(async () => ({ valid: true, scopes: [] }));
            client.start();
            sockets[0].emit("message", welcome("session-1"));
            await flushMicrotasks();
            expect(client.state).toBe("reauth_required");

            await vi.advanceTimersByTimeAsync(5 * 60_000);
            expect(sockets).toHaveLength(1);
            expect(client.state).toBe("reauth_required");

            client.stop();
            vi.useRealTimers();
        });

        it("keeps bounded reconnect/backoff for transient failures instead of entering reauth_required", async () => {
            const { client, sockets, attempts } = setup(async () => null);
            client.start();
            sockets[0].emit("message", welcome("session-1"));
            await flushMicrotasks();

            expect(client.state).toBe("reconnecting");
            await vi.advanceTimersByTimeAsync(1000);
            expect(sockets).toHaveLength(2);
            sockets[1].emit("message", welcome("session-2"));
            await flushMicrotasks();
            expect(attempts()).toBe(2);
            expect(client.state).toBe("reconnecting");

            client.stop();
            vi.useRealTimers();
        });
    });
});
