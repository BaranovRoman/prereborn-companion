import crypto from "crypto";
import { env } from "../config/env.js";
import { pool } from "../db/client.js";

const STATE_TTL_MS = 10 * 60 * 1000;
let appToken: { value: string; expiresAt: number } | null = null;

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
    return response.json() as Promise<{ access_token: string }>;
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
    user: { id: string; login: string; display_name: string; profile_image_url: string }
) => {
    await pool.query(
        `INSERT INTO stream_twitch_links
           (stream_user_id, twitch_user_id, login, display_name, profile_image_url)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (stream_user_id) DO UPDATE SET
           twitch_user_id = EXCLUDED.twitch_user_id,
           login = EXCLUDED.login,
           display_name = EXCLUDED.display_name,
           profile_image_url = EXCLUDED.profile_image_url,
           updated_at = CURRENT_TIMESTAMP`,
        [streamUserId, user.id, user.login, user.display_name, user.profile_image_url]
    );
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
    if (!link) return { connected: false, configured: Boolean(getTwitchConfig()) };

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
    };
};

export const disconnectTwitch = async (streamUserId: string) => {
    await pool.query("DELETE FROM stream_twitch_links WHERE stream_user_id = $1", [streamUserId]);
};
