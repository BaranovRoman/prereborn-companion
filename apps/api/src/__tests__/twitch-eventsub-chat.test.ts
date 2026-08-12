import { describe, expect, it, vi } from "vitest";
import { parseChatNotification, reconnectDelay, TwitchEventSubChatClient, type EventSubSocket } from "../services/twitch-eventsub-chat.js";

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
});
