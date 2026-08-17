import WebSocket from "ws";

export interface TwitchChatMessage {
    id: string;
    author: string;
    color: string | null;
    text: string;
    badges: string[];
    messageType: string;
    receivedAt: string;
}

type Envelope = {
    metadata?: { message_id?: string; message_type?: string; message_timestamp?: string };
    payload?: {
        session?: { id?: string; keepalive_timeout_seconds?: number | null; reconnect_url?: string | null };
        subscription?: { type?: string };
        event?: {
            message_id?: string;
            chatter_user_name?: string;
            color?: string;
            message_type?: string;
            message?: { text?: string };
            badges?: Array<{ set_id?: string; id?: string }>;
        };
    };
};

export interface EventSubSocket {
    on(event: "message", listener: (payload: unknown) => void): void;
    on(event: "close" | "error", listener: () => void): void;
    close(): void;
}

// A stored user access token can stop working for the chat subscription
// without ever being deleted: Twitch just starts rejecting the subscribe
// call once the granted scopes fall short of what channel.chat.message
// requires. "reauth_required" means the fix is a fresh OAuth consent, not
// another retry - see classifySubscribeFailure().
export type TwitchChatState = "connected" | "reconnecting" | "reauth_required";
export type SubscribeFailureClass = "reauth_required" | "transient";
export interface TwitchTokenValidation { valid: boolean; scopes: string[] }

// Scope required for the channel.chat.message EventSub subscription (added
// 2026-08-12, see twitch.ts connectTwitchController). Links created before
// that only hold the older, narrower scope set.
export const REQUIRED_CHAT_SCOPE = "user:read:chat";

export class TwitchSubscribeError extends Error {
    constructor(message: string, public readonly status: number | null) {
        super(message);
    }
}

interface Options {
    broadcasterId: string;
    clientId: string;
    getAccessToken: () => Promise<string | null>;
    onMessage: (message: TwitchChatMessage) => void;
    onConnected?: (value: boolean) => void;
    onError?: (error: unknown, classification: SubscribeFailureClass) => void;
    createSocket?: (url: string) => EventSubSocket;
    createSubscription?: (sessionId: string, token: string) => Promise<void>;
    validateToken?: (token: string) => Promise<TwitchTokenValidation | null>;
    setTimer?: typeof setTimeout;
    clearTimer?: typeof clearTimeout;
}

const SOCKET_URL = "wss://eventsub.wss.twitch.tv/ws?keepalive_timeout_seconds=30";

export const reconnectDelay = (attempt: number) => Math.min(30_000, 1_000 * 2 ** Math.min(attempt, 5));

export const parseChatNotification = (value: Envelope, seen: Set<string>): TwitchChatMessage | null => {
    if (value.metadata?.message_type !== "notification" || value.payload?.subscription?.type !== "channel.chat.message") return null;
    const eventId = value.metadata.message_id;
    const event = value.payload.event;
    if (!eventId || !event?.message_id || !event.chatter_user_name || !event.message?.text || seen.has(eventId) || seen.has(event.message_id)) return null;
    seen.add(eventId);
    seen.add(event.message_id);
    while (seen.size > 160) {
        const id = seen.values().next().value;
        if (id) seen.delete(id);
    }
    return {
        id: event.message_id,
        author: event.chatter_user_name,
        color: event.color || null,
        text: event.message.text,
        messageType: event.message_type || "text",
        badges: (event.badges ?? []).map((b) => `${b.set_id ?? ""}/${b.id ?? ""}`),
        receivedAt: value.metadata.message_timestamp || new Date().toISOString(),
    };
};

// Twitch's own scope-check for the subscribe request itself: 401/403 does
// NOT always mean "missing scope" (could be a transient Twitch-side hiccup,
// wrong broadcaster id, rate limiting, ...). We only trust reauth_required
// once oauth2/validate - Twitch's official token-introspection endpoint -
// structurally confirms the token is invalid or lacks REQUIRED_CHAT_SCOPE.
// A blocked/unreachable validate call is inconclusive and must NOT be
// treated as reauth_required, or a Twitch outage would wrongly tell users
// to redo OAuth consent.
export const classifySubscribeFailure = async (
    error: unknown,
    token: string | null,
    validateToken: (token: string) => Promise<TwitchTokenValidation | null>
): Promise<SubscribeFailureClass> => {
    if (!token) return "reauth_required";
    const status = error instanceof TwitchSubscribeError ? error.status : null;
    if (status !== 401 && status !== 403) return "transient";
    const validation = await validateToken(token).catch(() => null);
    if (!validation) return "transient";
    if (!validation.valid || !validation.scopes.includes(REQUIRED_CHAT_SCOPE)) return "reauth_required";
    return "transient";
};

const defaultValidateToken = async (token: string): Promise<TwitchTokenValidation | null> => {
    try {
        const response = await fetch("https://id.twitch.tv/oauth2/validate", {
            headers: { Authorization: `OAuth ${token}` },
        });
        if (response.status === 401) return { valid: false, scopes: [] };
        if (!response.ok) return null;
        const data = (await response.json()) as { scopes?: string[] };
        return { valid: true, scopes: data.scopes ?? [] };
    } catch {
        return null;
    }
};

export class TwitchEventSubChatClient {
    private socket: EventSubSocket | null = null;
    private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    private watchdog: ReturnType<typeof setTimeout> | null = null;
    private stopped = true;
    private attempt = 0;
    private generation = 0;
    private reauthRequired = false;
    private readonly seen = new Set<string>();
    private readonly createSocket: (url: string) => EventSubSocket;
    private readonly validateToken: (token: string) => Promise<TwitchTokenValidation | null>;
    private readonly setTimer: typeof setTimeout;
    private readonly clearTimer: typeof clearTimeout;

    constructor(private readonly options: Options) {
        this.createSocket = options.createSocket ?? ((url) => new WebSocket(url) as EventSubSocket);
        this.validateToken = options.validateToken ?? defaultValidateToken;
        this.setTimer = options.setTimer ?? setTimeout;
        this.clearTimer = options.clearTimer ?? clearTimeout;
    }

    start() {
        if (!this.stopped) return;
        this.stopped = false;
        this.reauthRequired = false;
        void this.open(SOCKET_URL, false);
    }

    stop() {
        this.stopped = true;
        this.generation++;
        this.options.onConnected?.(false);
        if (this.reconnectTimer) this.clearTimer(this.reconnectTimer);
        if (this.watchdog) this.clearTimer(this.watchdog);
        this.reconnectTimer = null;
        this.watchdog = null;
        const socket = this.socket;
        this.socket = null;
        socket?.close();
    }

    get connected() {
        return this.state === "connected";
    }

    get state(): TwitchChatState {
        if (this.reauthRequired) return "reauth_required";
        return this.socket ? "connected" : "reconnecting";
    }

    private armWatchdog(seconds = 30) {
        if (this.watchdog) this.clearTimer(this.watchdog);
        this.watchdog = this.setTimer(() => this.socket?.close(), (seconds + 10) * 1000);
    }

    private reconnect(generation: number) {
        if (this.stopped || this.reauthRequired || generation !== this.generation || this.reconnectTimer) return;
        this.options.onConnected?.(false);
        this.reconnectTimer = this.setTimer(() => {
            this.reconnectTimer = null;
            if (!this.stopped && !this.reauthRequired && generation === this.generation) void this.open(SOCKET_URL, false);
        }, reconnectDelay(this.attempt++));
    }

    private async subscribe(sessionId: string, token: string) {
        if (this.options.createSubscription) return this.options.createSubscription(sessionId, token);
        const response = await fetch("https://api.twitch.tv/helix/eventsub/subscriptions", {
            method: "POST",
            headers: { Authorization: `Bearer ${token}`, "Client-Id": this.options.clientId, "Content-Type": "application/json" },
            body: JSON.stringify({
                type: "channel.chat.message",
                version: "1",
                condition: { broadcaster_user_id: this.options.broadcasterId, user_id: this.options.broadcasterId },
                transport: { method: "websocket", session_id: sessionId },
            }),
        });
        if (!response.ok) throw new TwitchSubscribeError(`EventSub subscription returned ${response.status}`, response.status);
    }

    // Runs once the socket delivering `sessionId` has said hello. Resolves
    // the subscribe-vs-reauth question and never lets an unclassified
    // failure fall through to an unbounded reconnect.
    private async establishSubscription(socket: EventSubSocket, sessionId: string) {
        const token = await this.options.getAccessToken();
        if (!token) return this.handleSubscribeFailure(socket, new TwitchSubscribeError("Twitch user token unavailable", null), null);
        try {
            await this.subscribe(sessionId, token);
            if (socket === this.socket) {
                this.attempt = 0;
                this.reauthRequired = false;
                this.options.onConnected?.(true);
            }
        } catch (error) {
            await this.handleSubscribeFailure(socket, error, token);
        }
    }

    private async handleSubscribeFailure(socket: EventSubSocket, error: unknown, token: string | null) {
        const classification = await classifySubscribeFailure(error, token, this.validateToken);
        this.options.onError?.(error, classification);
        if (classification === "reauth_required") this.reauthRequired = true;
        socket.close();
    }

    private async open(url: string, sessionReconnect: boolean) {
        if (this.stopped) return;
        const generation = ++this.generation;
        const previous = this.socket;
        const socket = this.createSocket(url);
        if (this.watchdog) this.clearTimer(this.watchdog);
        this.watchdog = this.setTimer(() => socket.close(), 15_000);

        socket.on("message", (raw) => {
            let value: Envelope;
            try {
                value = JSON.parse(typeof raw === "string" ? raw : Buffer.isBuffer(raw) ? raw.toString() : String(raw));
            } catch {
                return;
            }
            this.armWatchdog(value.payload?.session?.keepalive_timeout_seconds ?? 30);

            if (value.metadata?.message_type === "session_welcome") {
                const sessionId = value.payload?.session?.id;
                if (!sessionId) return socket.close();
                this.socket = socket;
                if (sessionReconnect) {
                    this.attempt = 0;
                    this.reauthRequired = false;
                    this.options.onConnected?.(true);
                    previous?.close();
                } else {
                    void this.establishSubscription(socket, sessionId);
                }
                return;
            }
            if (value.metadata?.message_type === "session_reconnect" && socket === this.socket) {
                const next = value.payload?.session?.reconnect_url;
                if (next) void this.open(next, true);
                return;
            }
            const message = parseChatNotification(value, this.seen);
            if (message) this.options.onMessage(message);
        });
        socket.on("close", () => {
            if (generation !== this.generation) return;
            if (socket === this.socket) this.socket = null;
            this.reconnect(generation);
        });
        socket.on("error", () => socket.close());
    }
}
