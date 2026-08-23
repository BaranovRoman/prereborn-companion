import WebSocket from "ws";

export interface TwitchChatMessage {
    id: string;
    author: string;
    // Stable identity, independent of the mutable/cosmetic display name in
    // `author` - Twitch's own chatter_user_id (never changes, even across a
    // rename) and chatter_user_login (the lowercase ASCII handle, e.g. from
    // the channel URL - what a streamer actually types into pronunciation
    // overrides). Nullable rather than required: Twitch has always sent
    // these alongside chatter_user_name on channel.chat.message, but nothing
    // upstream depends on that continuing, so a payload missing them still
    // produces a usable message (falls back to `author`) instead of being
    // dropped.
    authorId: string | null;
    authorLogin: string | null;
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
            chatter_user_id?: string;
            chatter_user_login?: string;
            chatter_user_name?: string;
            color?: string;
            message_type?: string;
            message?: { text?: string };
            badges?: Array<{ set_id?: string; id?: string }>;
            // WK-72 - follow/subscribe/subscription.gift/raid event fields.
            // Twitch's field names differ per subscription type (e.g. raid
            // uses from_broadcaster_user_name instead of user_name), so this
            // stays a flat superset rather than one shape per type - see
            // parseViewerEventNotification for which fields each type reads.
            user_id?: string;
            user_login?: string;
            user_name?: string;
            tier?: string;
            is_gift?: boolean;
            total?: number;
            is_anonymous?: boolean;
            from_broadcaster_user_id?: string;
            from_broadcaster_user_login?: string;
            from_broadcaster_user_name?: string;
            viewers?: number;
        };
    };
};

// WK-72 - minimal public info Twitch sends for the event itself (WK-54's
// "no excess viewer data" boundary): no persisted history, no cross-event
// viewer profile, just what's needed to render a single alert.
export type TwitchViewerEventType = "follow" | "subscribe" | "giftSub" | "raid";

export type TwitchViewerEvent =
    | { id: string; type: "follow"; userName: string; userLogin: string | null; receivedAt: string }
    | { id: string; type: "subscribe"; userName: string; userLogin: string | null; tier: string; isGift: boolean; receivedAt: string }
    | { id: string; type: "giftSub"; userName: string | null; userLogin: string | null; tier: string; count: number; isAnonymous: boolean; receivedAt: string }
    | { id: string; type: "raid"; userName: string; userLogin: string | null; viewerCount: number; receivedAt: string };

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
    // WK-72 - follow/subscribe/subscription.gift/raid ride the same
    // WebSocket session as chat, but are deliberately NOT part of the chat
    // subscribe-or-fail state machine above: each is subscribed
    // independently and a failure here only reaches onViewerEventError,
    // never onError/handleSubscribeFailure - per WK-54, one type's failure
    // (e.g. a non-Affiliate channel can't get subscribe events) must never
    // tear down chat or the shared connection.
    onViewerEvent?: (event: TwitchViewerEvent) => void;
    onViewerEventError?: (type: string, error: unknown) => void;
    createViewerEventSubscription?: (
        sessionId: string,
        token: string,
        type: string,
        version: string,
        condition: Record<string, string>
    ) => Promise<void>;
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
        authorId: event.chatter_user_id || null,
        authorLogin: event.chatter_user_login || null,
        color: event.color || null,
        text: event.message.text,
        messageType: event.message_type || "text",
        badges: (event.badges ?? []).map((b) => `${b.set_id ?? ""}/${b.id ?? ""}`),
        receivedAt: value.metadata.message_timestamp || new Date().toISOString(),
    };
};

const VIEWER_EVENT_SUBSCRIPTION_TYPES = new Set([
    "channel.follow",
    "channel.subscribe",
    "channel.subscription.gift",
    "channel.raid",
]);

// WK-72 - dedups on the EventSub delivery id (metadata.message_id) alone:
// unlike chat, these subscription types carry no second Twitch-issued id to
// belt-and-suspenders against, and message_id is Twitch's documented
// at-least-once redelivery key. Shares `seen` with parseChatNotification -
// one connection, one dedup window, regardless of which subscription type a
// given delivery belongs to.
export const parseViewerEventNotification = (value: Envelope, seen: Set<string>): TwitchViewerEvent | null => {
    const type = value.payload?.subscription?.type;
    if (value.metadata?.message_type !== "notification" || !type || !VIEWER_EVENT_SUBSCRIPTION_TYPES.has(type)) return null;
    const eventId = value.metadata.message_id;
    const event = value.payload?.event;
    if (!eventId || !event || seen.has(eventId)) return null;
    const receivedAt = value.metadata.message_timestamp || new Date().toISOString();

    let result: TwitchViewerEvent | null = null;
    if (type === "channel.follow" && event.user_name) {
        result = { id: eventId, type: "follow", userName: event.user_name, userLogin: event.user_login || null, receivedAt };
    } else if (type === "channel.subscribe" && event.user_name && event.tier) {
        result = { id: eventId, type: "subscribe", userName: event.user_name, userLogin: event.user_login || null, tier: event.tier, isGift: Boolean(event.is_gift), receivedAt };
    } else if (type === "channel.subscription.gift" && event.tier && typeof event.total === "number") {
        result = { id: eventId, type: "giftSub", userName: event.user_name || null, userLogin: event.user_login || null, tier: event.tier, count: event.total, isAnonymous: Boolean(event.is_anonymous), receivedAt };
    } else if (type === "channel.raid" && event.from_broadcaster_user_name && typeof event.viewers === "number") {
        result = { id: eventId, type: "raid", userName: event.from_broadcaster_user_name, userLogin: event.from_broadcaster_user_login || null, viewerCount: event.viewers, receivedAt };
    }
    if (!result) return null;

    seen.add(eventId);
    while (seen.size > 160) {
        const id = seen.values().next().value;
        if (id) seen.delete(id);
    }
    return result;
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

    // WK-72 - condition shapes per Twitch's EventSub docs: channel.follow v2
    // requires moderator_user_id alongside broadcaster_user_id (the
    // moderator:read:followers scope already granted lets the broadcaster
    // use their own id for both - no new consent); channel.raid v1 keys off
    // to_broadcaster_user_id (this channel being raided), not
    // broadcaster_user_id.
    private static readonly VIEWER_EVENT_SUBSCRIPTIONS: ReadonlyArray<{
        type: string;
        version: string;
        condition: (broadcasterId: string) => Record<string, string>;
    }> = [
        { type: "channel.follow", version: "2", condition: (id) => ({ broadcaster_user_id: id, moderator_user_id: id }) },
        { type: "channel.subscribe", version: "1", condition: (id) => ({ broadcaster_user_id: id }) },
        { type: "channel.subscription.gift", version: "1", condition: (id) => ({ broadcaster_user_id: id }) },
        { type: "channel.raid", version: "1", condition: (id) => ({ to_broadcaster_user_id: id }) },
    ];

    private async subscribeViewerEvent(sessionId: string, token: string, type: string, version: string, condition: Record<string, string>) {
        if (this.options.createViewerEventSubscription) {
            return this.options.createViewerEventSubscription(sessionId, token, type, version, condition);
        }
        const response = await fetch("https://api.twitch.tv/helix/eventsub/subscriptions", {
            method: "POST",
            headers: { Authorization: `Bearer ${token}`, "Client-Id": this.options.clientId, "Content-Type": "application/json" },
            body: JSON.stringify({ type, version, condition, transport: { method: "websocket", session_id: sessionId } }),
        });
        if (!response.ok) throw new TwitchSubscribeError(`EventSub subscription returned ${response.status}`, response.status);
    }

    // Deliberately independent of establishSubscription()/handleSubscribeFailure():
    // runs alongside chat, never blocks it, never closes the socket, and
    // each of the four types is caught individually so one failing type
    // (e.g. subscribe/gift on a non-Affiliate channel - a normal, expected
    // case per WK-54, not an error) can't take down the other three or chat.
    private async establishViewerEventSubscriptions(socket: EventSubSocket, sessionId: string) {
        const token = await this.options.getAccessToken();
        if (!token) return;
        await Promise.all(
            TwitchEventSubChatClient.VIEWER_EVENT_SUBSCRIPTIONS.map(async (sub) => {
                try {
                    await this.subscribeViewerEvent(sessionId, token, sub.type, sub.version, sub.condition(this.options.broadcasterId));
                } catch (error) {
                    if (socket === this.socket) this.options.onViewerEventError?.(sub.type, error);
                }
            })
        );
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
                    // Twitch persists subscriptions across a session_reconnect
                    // handoff (that's the point of reconnect_url) - only the
                    // first, non-reconnect welcome needs a fresh subscribe,
                    // same as establishSubscription's chat path above.
                    void this.establishViewerEventSubscriptions(socket, sessionId);
                }
                return;
            }
            if (value.metadata?.message_type === "session_reconnect" && socket === this.socket) {
                const next = value.payload?.session?.reconnect_url;
                if (next) void this.open(next, true);
                return;
            }
            const message = parseChatNotification(value, this.seen);
            if (message) {
                this.options.onMessage(message);
                return;
            }
            const viewerEvent = parseViewerEventNotification(value, this.seen);
            if (viewerEvent) this.options.onViewerEvent?.(viewerEvent);
        });
        socket.on("close", () => {
            if (generation !== this.generation) return;
            if (socket === this.socket) this.socket = null;
            this.reconnect(generation);
        });
        socket.on("error", () => socket.close());
    }
}
