import crypto from "crypto";
import { env } from "../config/env.js";
import { pool } from "../db/client.js";

const STATE_TTL_MS = 10 * 60 * 1000;
const SCOPES = "oauth-user-show oauth-donation-index oauth-donation-subscribe";

export const getDonationAlertsConfig = () => {
    if (!env.donationAlertsClientId || !env.donationAlertsClientSecret ||
        !env.donationAlertsRedirectUri || !env.donationAlertsFrontendOrigin) return null;
    return {
        clientId: env.donationAlertsClientId,
        clientSecret: env.donationAlertsClientSecret,
        redirectUri: env.donationAlertsRedirectUri,
        frontendOrigin: env.donationAlertsFrontendOrigin,
    };
};

export const createDonationAlertsState = async (streamUserId: string) => {
    await pool.query("DELETE FROM stream_donation_alerts_connect_states WHERE expires_at < NOW()");
    const state = crypto.randomBytes(24).toString("base64url");
    await pool.query(
        `INSERT INTO stream_donation_alerts_connect_states (state, stream_user_id, expires_at)
         VALUES ($1, $2, $3)`,
        [state, streamUserId, new Date(Date.now() + STATE_TTL_MS)]
    );
    return state;
};

export const consumeDonationAlertsState = async (state: string) => {
    const result = await pool.query<{ stream_user_id: number; expires_at: Date }>(
        `DELETE FROM stream_donation_alerts_connect_states WHERE state = $1
         RETURNING stream_user_id, expires_at`, [state]
    );
    const row = result.rows[0];
    return row && row.expires_at.getTime() >= Date.now() ? String(row.stream_user_id) : null;
};

type TokenResponse = {
    access_token: string; refresh_token?: string; expires_in: number; token_type: string;
};

const exchangeToken = async (body: URLSearchParams): Promise<TokenResponse> => {
    const response = await fetch("https://www.donationalerts.com/oauth/token", {
        method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body,
    });
    if (!response.ok) throw new Error(`DonationAlerts token endpoint returned ${response.status}`);
    return response.json() as Promise<TokenResponse>;
};

export const exchangeDonationAlertsCode = async (code: string) => {
    const config = getDonationAlertsConfig();
    if (!config) throw new Error("DonationAlerts integration is not configured");
    return exchangeToken(new URLSearchParams({
        grant_type: "authorization_code", client_id: config.clientId,
        client_secret: config.clientSecret, redirect_uri: config.redirectUri, code,
    }));
};

const apiFetch = async <T>(path: string, token: string): Promise<T> => {
    const response = await fetch(`https://www.donationalerts.com/api/v1${path}`, {
        headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) throw new Error(`DonationAlerts API returned ${response.status}`);
    return response.json() as Promise<T>;
};

export const getDonationAlertsUser = async (token: string) =>
    (await apiFetch<{ data: { id: number; code: string; name: string; avatar: string | null } }>(
        "/user/oauth", token
    )).data;

export const saveDonationAlertsLink = async (
    streamUserId: string, user: { id: number; code: string; name: string; avatar: string | null },
    token: TokenResponse
) => {
    await pool.query(
        `INSERT INTO stream_donation_alerts_links
         (stream_user_id, donation_alerts_user_id, code, display_name, avatar_url,
          access_token, refresh_token, token_expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (stream_user_id) DO UPDATE SET
          donation_alerts_user_id=EXCLUDED.donation_alerts_user_id, code=EXCLUDED.code,
          display_name=EXCLUDED.display_name, avatar_url=EXCLUDED.avatar_url,
          access_token=EXCLUDED.access_token, refresh_token=EXCLUDED.refresh_token,
          token_expires_at=EXCLUDED.token_expires_at, updated_at=CURRENT_TIMESTAMP`,
        [streamUserId, user.id, user.code, user.name, user.avatar, token.access_token,
         token.refresh_token ?? null, new Date(Date.now() + token.expires_in * 1000)]
    );
};

type LinkRow = {
    donation_alerts_user_id: string; code: string; display_name: string; avatar_url: string | null;
    access_token: string; refresh_token: string | null; token_expires_at: Date | null; connected_at: Date;
};

const getLink = async (streamUserId: string) => {
    const result = await pool.query<LinkRow>(
        `SELECT donation_alerts_user_id, code, display_name, avatar_url, access_token,
                refresh_token, token_expires_at, connected_at
         FROM stream_donation_alerts_links WHERE stream_user_id=$1`, [streamUserId]
    );
    return result.rows[0] ?? null;
};

const validToken = async (streamUserId: string, link: LinkRow) => {
    if (!link.token_expires_at || link.token_expires_at.getTime() > Date.now() + 60_000)
        return link.access_token;
    const config = getDonationAlertsConfig();
    if (!config || !link.refresh_token) throw new Error("DonationAlerts token expired");
    const token = await exchangeToken(new URLSearchParams({
        grant_type: "refresh_token", refresh_token: link.refresh_token,
        client_id: config.clientId, client_secret: config.clientSecret, scope: SCOPES,
    }));
    await pool.query(
        `UPDATE stream_donation_alerts_links SET access_token=$2,
         refresh_token=COALESCE($3, refresh_token), token_expires_at=$4, updated_at=CURRENT_TIMESTAMP
         WHERE stream_user_id=$1`,
        [streamUserId, token.access_token, token.refresh_token ?? null,
         new Date(Date.now() + token.expires_in * 1000)]
    );
    return token.access_token;
};

export const getDonationAlertsStatus = async (streamUserId: string) => {
    const link = await getLink(streamUserId);
    if (!link) return { connected: false, configured: Boolean(getDonationAlertsConfig()), donations: [] };
    const token = await validToken(streamUserId, link);
    const result = await apiFetch<{ data: Array<{
        id: number; username: string; message: string; amount: number; currency: string; created_at: string;
    }> }>("/alerts/donations?page=1", token);
    return {
        connected: true, configured: true, code: link.code, displayName: link.display_name,
        avatarUrl: link.avatar_url, connectedAt: link.connected_at,
        donations: result.data.slice(0, 30).map((item) => ({
            id: item.id, username: item.username, message: item.message,
            amount: item.amount, currency: item.currency, createdAt: item.created_at,
        })),
    };
};

export const disconnectDonationAlerts = async (streamUserId: string) => {
    await pool.query("DELETE FROM stream_donation_alerts_links WHERE stream_user_id=$1", [streamUserId]);
};

export { SCOPES as DONATION_ALERTS_SCOPES };
