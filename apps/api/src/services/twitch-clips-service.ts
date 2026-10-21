import { pool } from "../db/client.js";
import { logger } from "../utils/logger.js";
import { validateTwitchToken, type TwitchTokenValidation } from "./twitch-eventsub-chat.js";
import { getTwitchConfig, getTwitchUserToken } from "./twitch-integration-service.js";

// WK-178 - Companion's "clip on a hotkey". The Twitch user token lives here
// (stream_twitch_links), never in Companion, so the clip is created through
// this service with the same token the chat/audience features already use.
//
// Helix flow (https://dev.twitch.tv/docs/api/reference/#create-clip):
// POST /helix/clips answers 202 with only an id + edit_url - the clip is cut
// asynchronously. Twitch documents that if Get Clips still doesn't return
// the id ~15 s later, the clip failed. So "success" here means Get Clips
// confirmed it, not just that Create Clip was accepted.

export const CLIPS_SCOPE = "clips:edit";
// Create Clip's `duration` query parameter: 5..60 s, 0.1 s precision,
// Twitch's own default is 30.
export const CLIP_DURATION_MIN_SECONDS = 5;
export const CLIP_DURATION_MAX_SECONDS = 60;
export const CLIP_DURATION_DEFAULT_SECONDS = 30;

const POLL_INTERVAL_MS = 1_000;
const POLL_TIMEOUT_MS = 15_000;

export type ClipErrorCode =
    | "not_configured"
    | "not_connected"
    | "reauth_required"
    | "not_live"
    | "clips_restricted"
    | "clip_rejected"
    | "rate_limited"
    | "twitch_unavailable"
    | "clip_failed";

export interface CreatedClip {
    id: string;
    url: string;
    editUrl: string | null;
    title: string | null;
    durationSeconds: number | null;
    createdAt: string;
    thumbnailUrl: string | null;
}

export type ClipResult =
    | { ok: true; clip: CreatedClip }
    | { ok: false; code: ClipErrorCode; message: string };

const MESSAGES: Record<ClipErrorCode, string> = {
    not_configured: "Twitch-интеграция не настроена на сервере.",
    not_connected: "Twitch не подключён. Подключите Twitch в Настройки → Интеграции.",
    reauth_required: "Недостаточно разрешений Twitch для создания клипов. Переподключите Twitch.",
    not_live: "Трансляция не запущена — клип можно создать только во время эфира.",
    clips_restricted: "Создание клипов запрещено настройками канала (клипы выключены или доступны не всем).",
    clip_rejected: "Twitch отклонил запрос на клип (например, текущую категорию нельзя клипать).",
    rate_limited: "Слишком много запросов к Twitch. Подождите немного и попробуйте снова.",
    twitch_unavailable: "Twitch API недоступен. Попробуйте ещё раз чуть позже.",
    clip_failed: "Twitch принял запрос, но клип не был создан. Попробуйте ещё раз.",
};

const failure = (code: ClipErrorCode): ClipResult => ({ ok: false, code, message: MESSAGES[code] });

export const clampClipDuration = (seconds: number | undefined): number => {
    if (seconds === undefined || !Number.isFinite(seconds)) return CLIP_DURATION_DEFAULT_SECONDS;
    const clamped = Math.min(CLIP_DURATION_MAX_SECONDS, Math.max(CLIP_DURATION_MIN_SECONDS, seconds));
    return Math.round(clamped * 10) / 10;
};

// Mapping of Create Clip's documented status codes. 401 is the only one
// Twitch documents for a missing clips:edit scope / invalid token, so it is
// the reauth signal; 403 is the channel's own clip restrictions.
export const classifyCreateClipStatus = (status: number): ClipErrorCode | null => {
    if (status === 200 || status === 202) return null;
    if (status === 401) return "reauth_required";
    if (status === 403) return "clips_restricted";
    if (status === 404) return "not_live";
    if (status === 400) return "clip_rejected";
    if (status === 429) return "rate_limited";
    return "twitch_unavailable";
};

export interface ClipDeps {
    fetch: typeof fetch;
    sleep: (ms: number) => Promise<void>;
    now: () => number;
    pollIntervalMs: number;
    pollTimeoutMs: number;
}

const defaultDeps: ClipDeps = {
    fetch: (...args) => fetch(...args),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
    pollIntervalMs: POLL_INTERVAL_MS,
    pollTimeoutMs: POLL_TIMEOUT_MS,
};

interface HelixClip {
    id: string;
    url: string;
    title?: string;
    duration?: number;
    created_at?: string;
    thumbnail_url?: string;
}

const readTwitchMessage = async (response: Response) => {
    try {
        const body = (await response.json()) as { message?: string };
        return body.message ?? null;
    } catch {
        return null;
    }
};

export const createClipForBroadcaster = async (
    input: { broadcasterId: string; accessToken: string; clientId: string; durationSeconds?: number },
    overrides: Partial<ClipDeps> = {}
): Promise<ClipResult> => {
    const deps = { ...defaultDeps, ...overrides };
    const headers = { Authorization: `Bearer ${input.accessToken}`, "Client-Id": input.clientId };
    const createUrl = new URL("https://api.twitch.tv/helix/clips");
    createUrl.searchParams.set("broadcaster_id", input.broadcasterId);
    createUrl.searchParams.set("duration", clampClipDuration(input.durationSeconds).toFixed(1));

    let created: { id: string; edit_url?: string } | undefined;
    try {
        const response = await deps.fetch(createUrl, { method: "POST", headers });
        const code = classifyCreateClipStatus(response.status);
        if (code) {
            // Twitch's own message is English and may name the reason (e.g.
            // "category is not clippable") - logged for support, not shown.
            logger.warn("Twitch create clip rejected", {
                status: response.status,
                code,
                twitchMessage: await readTwitchMessage(response),
            });
            return failure(code);
        }
        const body = (await response.json()) as { data?: Array<{ id: string; edit_url?: string }> };
        created = body.data?.[0];
    } catch (error) {
        logger.warn("Twitch create clip request failed", {
            message: error instanceof Error ? error.message : String(error),
        });
        return failure("twitch_unavailable");
    }
    if (!created?.id) return failure("clip_failed");

    const lookupUrl = new URL("https://api.twitch.tv/helix/clips");
    lookupUrl.searchParams.set("id", created.id);
    const deadline = deps.now() + deps.pollTimeoutMs;
    while (deps.now() < deadline) {
        await deps.sleep(deps.pollIntervalMs);
        try {
            const response = await deps.fetch(lookupUrl, { headers });
            if (!response.ok) continue; // a transient lookup failure just waits for the next poll
            const body = (await response.json()) as { data?: HelixClip[] };
            const clip = body.data?.find(({ id }) => id === created!.id);
            if (clip) {
                return {
                    ok: true,
                    clip: {
                        id: clip.id,
                        url: clip.url,
                        editUrl: created.edit_url ?? null,
                        title: clip.title || null,
                        durationSeconds: typeof clip.duration === "number" ? clip.duration : null,
                        createdAt: clip.created_at ?? new Date(deps.now()).toISOString(),
                        thumbnailUrl: clip.thumbnail_url || null,
                    },
                };
            }
        } catch {
            // Same as a non-ok lookup: keep polling until the deadline.
        }
    }
    return failure("clip_failed");
};

const getLinkedBroadcasterId = async (streamUserId: string) => {
    const result = await pool.query<{ twitch_user_id: string }>(
        "SELECT twitch_user_id FROM stream_twitch_links WHERE stream_user_id = $1",
        [streamUserId]
    );
    return result.rows[0]?.twitch_user_id ?? null;
};

export const createTwitchClip = async (
    streamUserId: string,
    durationSeconds: number | undefined,
    overrides: Partial<ClipDeps> = {}
): Promise<ClipResult> => {
    const config = getTwitchConfig();
    if (!config) return failure("not_configured");
    const broadcasterId = await getLinkedBroadcasterId(streamUserId);
    if (!broadcasterId) return failure("not_connected");
    const accessToken = await getTwitchUserToken(streamUserId);
    // A link whose refresh failed can't be repaired without a new consent.
    if (!accessToken) return failure("reauth_required");
    const result = await createClipForBroadcaster(
        { broadcasterId, accessToken, clientId: config.clientId, durationSeconds },
        overrides
    );
    if (result.ok) logger.info("Twitch clip created", { streamUserId, clipId: result.clip.id });
    else logger.warn("Twitch clip failed", { streamUserId, code: result.code });
    return result;
};

export interface TwitchClipsAccess {
    configured: boolean;
    accountConnected: boolean;
    // null = Twitch's validate endpoint was unreachable, so we can't tell.
    scopeGranted: boolean | null;
    duration: { min: number; max: number; default: number };
}

export const hasClipsScope = (validation: TwitchTokenValidation | null): boolean | null =>
    validation ? validation.valid && validation.scopes.includes(CLIPS_SCOPE) : null;

export const getTwitchClipsAccess = async (
    streamUserId: string,
    validate: (token: string) => Promise<TwitchTokenValidation | null> = validateTwitchToken
): Promise<TwitchClipsAccess> => {
    const duration = {
        min: CLIP_DURATION_MIN_SECONDS,
        max: CLIP_DURATION_MAX_SECONDS,
        default: CLIP_DURATION_DEFAULT_SECONDS,
    };
    const configured = Boolean(getTwitchConfig());
    if (!configured || !(await getLinkedBroadcasterId(streamUserId))) {
        return { configured, accountConnected: false, scopeGranted: null, duration };
    }
    const token = await getTwitchUserToken(streamUserId);
    if (!token) return { configured, accountConnected: true, scopeGranted: false, duration };
    return { configured, accountConnected: true, scopeGranted: hasClipsScope(await validate(token)), duration };
};
