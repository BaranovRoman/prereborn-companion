import crypto from "crypto";
import WebSocket from "ws";
import { env } from "../config/env.js";
import { pool } from "../db/client.js";

const STATE_TTL_MS = 10 * 60 * 1000;
const CHAT_MESSAGE_LIMIT = 40;
let appToken: { value: string; expiresAt: number } | null = null;

interface TwitchToken {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
}

interface TwitchChatMessage {
    id: string;
    author: string;
    color: string | null;
    text: string;
    badges: string[];
    receivedAt: string;
}

interface TwitchSubscriber {
    id: string;
    name: string;
    tier: string;
    isGift: boolean;
    receivedAt: string;
}

interface TwitchFollower {
    id: string;
    name: string;
    followedAt: string;
}

interface TwitchAudience {
    subscribers: TwitchSubscriber[];
    followers: TwitchFollower[];
    expiresAt: number;
}

interface TwitchChatConnection {
    socket: WebSocket;
    connected: boolean;
    reconnectTimer?: ReturnType<typeof setTimeout>;
}

const chatConnections = new Map<string, TwitchChatConnection>();
const chatMessages = new Map<string, TwitchChatMessage[]>();
const recentSubscribers = new Map<string, TwitchSubscriber[]>();
const audienceCache = new Map<string, TwitchAudience>();

export const getTwitchConfig = () => {
    if (
        !env.twitchClientId ||
        !env.twitchClientSecret ||
        !env.twitchRedirectUri ||
        !env.twitchFrontendOrigin
    ) return null;
    return {
        clientId: env.twitchClientId,
        clientSecret: env.twitchClientSecret,
        redirectUri: env.twitchRedirectUri,
        frontendOrigin: env.twitchFrontendOrigin,
    };
};

export const createTwitchState = async (streamUserId: string) => {
    await pool.query("DELETE FROM stream_twitch_connect_states WHERE expires_at < NOW()");
    const state = crypto.randomBytes(24).toString("base64url");
    await pool.query(
        `INSERT INTO stream_twitch_connect_states (state, stream_user_id, expires_at)
         VALUES ($1, $2, $3)`,
        [state, streamUserId, new Date(Date.now() + STATE_TTL_MS)]
    );
    return state;
};

export const consumeTwitchState = async (state: string) => {
    const result = await pool.query<{ stream_user_id: number; expires_at: Date }>(
        `DELETE FROM stream_twitch_connect_states WHERE state = $1
         RETURNING stream_user_id, expires_at`,
        [state]
    );
    const row = result.rows[0];
    return row && row.expires_at.getTime() >= Date.now()
        ? row.stream_user_id.toString()
        : null;
};

const twitchFetch = async <T>(url: string, accessToken: string, clientId: string): Promise<T> => {
    const response = await fetch(url, {
        headers: { Authorization: `Bearer ${accessToken}`, "Client-Id": clientId },
    });
    if (!response.ok) throw new Error(`Twitch API returned ${response.status}`);
    return response.json() as Promise<T>;
};

export const exchangeTwitchCode = async (code: string) => {
    const config = getTwitchConfig();
    if (!config) throw new Error("Twitch integration is not configured");
    const body = new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        code,
        grant_type: "authorization_code",
        redirect_uri: config.redirectUri,
    });
    const response = await fetch("https://id.twitch.tv/oauth2/token", { method: "POST", body });
    if (!response.ok) throw new Error(`Twitch token exchange returned ${response.status}`);
    return response.json() as Promise<TwitchToken>;
};

export const getTwitchUser = async (accessToken: string) => {
    const config = getTwitchConfig();
    if (!config) throw new Error("Twitch integration is not configured");
    const result = await twitchFetch<{
        data: Array<{ id: string; login: string; display_name: string; profile_image_url: string }>;
    }>("https://api.twitch.tv/helix/users", accessToken, config.clientId);
    if (!result.data[0]) throw new Error("Twitch user was not returned");
    return result.data[0];
};

export const saveTwitchLink = async (
    streamUserId: string,
    user: { id: string; login: string; display_name: string; profile_image_url: string },
    token: TwitchToken
) => {
    await pool.query(
        `INSERT INTO stream_twitch_links
           (stream_user_id, twitch_user_id, login, display_name, profile_image_url,
            access_token, refresh_token, token_expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (stream_user_id) DO UPDATE SET
           twitch_user_id = EXCLUDED.twitch_user_id,
           login = EXCLUDED.login,
           display_name = EXCLUDED.display_name,
           profile_image_url = EXCLUDED.profile_image_url,
           access_token = EXCLUDED.access_token,
           refresh_token = EXCLUDED.refresh_token,
           token_expires_at = EXCLUDED.token_expires_at,
           updated_at = CURRENT_TIMESTAMP`,
        [
            streamUserId,
            user.id,
            user.login,
            user.display_name,
            user.profile_image_url,
            token.access_token,
            token.refresh_token ?? null,
            new Date(Date.now() + token.expires_in * 1000),
        ]
    );
    stopTwitchChat(streamUserId);
};

const parseIrcTags = (raw: string) =>
    Object.fromEntries(
        raw.split(";").map((entry) => {
            const [key, ...value] = entry.split("=");
            return [key, value.join("=")];
        })
    );

const decodeIrcTag = (value: string) =>
    value
        .replaceAll("\\s", " ")
        .replaceAll("\\:", ";")
        .replaceAll("\\r", "\r")
        .replaceAll("\\n", "\n")
        .replaceAll("\\\\", "\\");

const appendChatMessage = (streamUserId: string, line: string) => {
    const match = line.match(/^@([^ ]+) :[^ ]+ PRIVMSG #[^ ]+ :([\s\S]*)$/);
    if (!match) return;
    const tags = parseIrcTags(match[1]);
    const author = decodeIrcTag(tags["display-name"] || "");
    if (!author) return;
    const message: TwitchChatMessage = {
        id: tags.id || crypto.randomUUID(),
        author,
        color: tags.color || null,
        text: match[2],
        badges: (tags.badges || "").split(",").filter(Boolean),
        receivedAt: new Date().toISOString(),
    };
    const next = [...(chatMessages.get(streamUserId) ?? []), message].slice(-CHAT_MESSAGE_LIMIT);
    chatMessages.set(streamUserId, next);
};

const appendSubscriber = (streamUserId: string, line: string) => {
    const match = line.match(/^@([^ ]+) :[^ ]+ USERNOTICE #[^ ]+/);
    if (!match) return;
    const tags = parseIrcTags(match[1]);
    const kind = tags["msg-id"];
    if (!["sub", "resub", "subgift", "anonsubgift"].includes(kind)) return;
    const name = decodeIrcTag(
        tags["msg-param-recipient-display-name"] || tags["display-name"] || "Anonymous"
    );
    const subscriber: TwitchSubscriber = {
        id: tags.id || crypto.randomUUID(),
        name,
        tier: tags["msg-param-sub-plan"] || "1000",
        isGift: kind === "subgift" || kind === "anonsubgift",
        receivedAt: new Date().toISOString(),
    };
    const next = [subscriber, ...(recentSubscribers.get(streamUserId) ?? [])]
        .filter((entry, index, list) => list.findIndex((item) => item.name === entry.name) === index)
        .slice(0, 6);
    recentSubscribers.set(streamUserId, next);
};

const getTwitchUserToken = async (streamUserId: string) => {
    const result = await pool.query<{
        access_token: string | null;
        refresh_token: string | null;
        token_expires_at: Date | null;
    }>(
        `SELECT access_token, refresh_token, token_expires_at
         FROM stream_twitch_links WHERE stream_user_id = $1`,
        [streamUserId]
    );
    const link = result.rows[0];
    if (!link?.access_token) return null;
    if (!link.token_expires_at || link.token_expires_at.getTime() > Date.now() + 60_000) {
        return link.access_token;
    }
    const config = getTwitchConfig();
    if (!config || !link.refresh_token) return null;
    const body = new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        grant_type: "refresh_token",
        refresh_token: link.refresh_token,
    });
    const response = await fetch("https://id.twitch.tv/oauth2/token", { method: "POST", body });
    if (!response.ok) return null;
    const token = await response.json() as TwitchToken;
    await pool.query(
        `UPDATE stream_twitch_links
         SET access_token = $2, refresh_token = COALESCE($3, refresh_token),
             token_expires_at = $4, updated_at = CURRENT_TIMESTAMP
         WHERE stream_user_id = $1`,
        [
            streamUserId,
            token.access_token,
            token.refresh_token ?? null,
            new Date(Date.now() + token.expires_in * 1000),
        ]
    );
    return token.access_token;
};

const stopTwitchChat = (streamUserId: string) => {
    const connection = chatConnections.get(streamUserId);
    if (!connection) return;
    if (connection.reconnectTimer) clearTimeout(connection.reconnectTimer);
    chatConnections.delete(streamUserId);
    connection.socket.close();
};

const ensureTwitchChat = async (streamUserId: string, login: string) => {
    if (chatConnections.has(streamUserId)) return;
    const accessToken = await getTwitchUserToken(streamUserId);
    if (!accessToken) return;

    const socket = new WebSocket("wss://irc-ws.chat.twitch.tv:443");
    const connection: TwitchChatConnection = { socket, connected: false };
    chatConnections.set(streamUserId, connection);

    socket.on("open", () => {
        socket.send("CAP REQ :twitch.tv/tags twitch.tv/commands");
        socket.send(`PASS oauth:${accessToken}`);
        socket.send(`NICK ${login}`);
        socket.send(`JOIN #${login}`);
    });
    socket.on("message", (payload) => {
        const lines = payload.toString().split("\r\n");
        for (const line of lines) {
            if (line.startsWith("PING ")) {
                socket.send(line.replace("PING", "PONG"));
                continue;
            }
            if (line.includes(" 001 ") || line.includes(" JOIN #")) connection.connected = true;
            appendChatMessage(streamUserId, line);
            appendSubscriber(streamUserId, line);
        }
    });
    socket.on("close", () => {
        if (chatConnections.get(streamUserId) !== connection) return;
        chatConnections.delete(streamUserId);
        connection.reconnectTimer = setTimeout(() => {
            void ensureTwitchChat(streamUserId, login);
        }, 5_000);
    });
    socket.on("error", () => socket.close());
};

const getTwitchAudience = async (streamUserId: string, broadcasterId: string) => {
    const cached = audienceCache.get(streamUserId);
    if (cached && cached.expiresAt > Date.now()) return cached;
    const config = getTwitchConfig();
    const token = await getTwitchUserToken(streamUserId);
    if (!config || !token) {
        return {
            subscribers: recentSubscribers.get(streamUserId) ?? [],
            followers: [],
            expiresAt: Date.now() + 15_000,
        };
    }

    const [subscriptionsResponse, followersResponse] = await Promise.all([
        fetch(
            `https://api.twitch.tv/helix/subscriptions?broadcaster_id=${encodeURIComponent(broadcasterId)}&first=100`,
            { headers: { Authorization: `Bearer ${token}`, "Client-Id": config.clientId } }
        ),
        fetch(
            `https://api.twitch.tv/helix/channels/followers?broadcaster_id=${encodeURIComponent(broadcasterId)}&first=100`,
            { headers: { Authorization: `Bearer ${token}`, "Client-Id": config.clientId } }
        ),
    ]).catch(() => [null, null] as const);

    const subscriptionData = subscriptionsResponse?.ok
        ? await subscriptionsResponse.json() as {
            data: Array<{
                user_id: string;
                user_name: string;
                tier: string;
                is_gift: boolean;
            }>;
        }
        : { data: [] };
    const followerData = followersResponse?.ok
        ? await followersResponse.json() as {
            data: Array<{
                user_id: string;
                user_name: string;
                followed_at: string;
            }>;
        }
        : { data: [] };

    const audience: TwitchAudience = {
        subscribers: subscriptionData.data.map((subscriber) => ({
            id: subscriber.user_id,
            name: subscriber.user_name,
            tier: subscriber.tier,
            isGift: subscriber.is_gift,
            receivedAt: new Date().toISOString(),
        })),
        followers: followerData.data.map((follower) => ({
            id: follower.user_id,
            name: follower.user_name,
            followedAt: follower.followed_at,
        })),
        expiresAt: Date.now() + 60_000,
    };
    audienceCache.set(streamUserId, audience);
    recentSubscribers.set(streamUserId, audience.subscribers);
    return audience;
};

const getAppToken = async () => {
    const config = getTwitchConfig();
    if (!config) return null;
    if (appToken && appToken.expiresAt > Date.now() + 60_000) return appToken.value;
    const body = new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        grant_type: "client_credentials",
    });
    const response = await fetch("https://id.twitch.tv/oauth2/token", { method: "POST", body });
    if (!response.ok) throw new Error(`Twitch app token returned ${response.status}`);
    const token = await response.json() as { access_token: string; expires_in: number };
    appToken = { value: token.access_token, expiresAt: Date.now() + token.expires_in * 1000 };
    return appToken.value;
};

export const getTwitchStatus = async (streamUserId: string) => {
    const result = await pool.query<{
        twitch_user_id: string; login: string; display_name: string;
        profile_image_url: string | null; connected_at: Date;
    }>(
        `SELECT twitch_user_id, login, display_name, profile_image_url, connected_at
         FROM stream_twitch_links WHERE stream_user_id = $1`,
        [streamUserId]
    );
    const link = result.rows[0];
    if (!link) {
        return {
            connected: false,
            configured: Boolean(getTwitchConfig()),
            chat: { connected: false, messages: [] },
            recentSubscribers: [],
            recentFollowers: [],
        };
    }

    void ensureTwitchChat(streamUserId, link.login);
    const audience = await getTwitchAudience(streamUserId, link.twitch_user_id);

    let live: null | { title: string; viewerCount: number; gameName: string } = null;
    const config = getTwitchConfig();
    const token = await getAppToken();
    if (config && token) {
        const streams = await twitchFetch<{
            data: Array<{ title: string; viewer_count: number; game_name: string }>;
        }>(
            `https://api.twitch.tv/helix/streams?user_id=${encodeURIComponent(link.twitch_user_id)}`,
            token,
            config.clientId
        );
        const stream = streams.data[0];
        if (stream) live = {
            title: stream.title,
            viewerCount: stream.viewer_count,
            gameName: stream.game_name,
        };
    }
    return {
        connected: true,
        configured: Boolean(config),
        login: link.login,
        displayName: link.display_name,
        profileImageUrl: link.profile_image_url,
        connectedAt: link.connected_at,
        live,
        chat: {
            connected: chatConnections.get(streamUserId)?.connected ?? false,
            messages: chatMessages.get(streamUserId) ?? [],
        },
        recentSubscribers: audience.subscribers,
        recentFollowers: audience.followers,
    };
};

export const disconnectTwitch = async (streamUserId: string) => {
    stopTwitchChat(streamUserId);
    chatMessages.delete(streamUserId);
    recentSubscribers.delete(streamUserId);
    audienceCache.delete(streamUserId);
    await pool.query("DELETE FROM stream_twitch_links WHERE stream_user_id = $1", [streamUserId]);
};
