import { pool } from "../db/client.js";
import { logger } from "../utils/logger.js";

// WK-186 - Companion usage stats. The only activity source is the
// authenticated Companion heartbeat; the website tracks nothing. All
// definitions below are UTC and documented in
// docs/analytics/companion-usage-stats.md.

const DAY_MS = 24 * 60 * 60 * 1000;

// Activity rows older than this are deleted. Must stay above the longest
// window the stats read (30 rolling days / 30 full calendar days).
export const ACTIVITY_RETENTION_DAYS = 90;
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;

export const AVERAGE_DAU_DAYS = 30;

const PUBLIC_CACHE_TTL_MS = 5 * 60 * 1000;

export type UsageStats = {
    registeredUsers: number;
    /** Distinct accounts with a heartbeat in the last 24 hours (rolling). */
    dau: number;
    /** Distinct accounts with a heartbeat in the last 7 days (rolling). */
    wau: number;
    /** Distinct accounts with a heartbeat in the last 30 days (rolling). */
    mau: number;
    /** Mean of daily distinct accounts over the last 30 full UTC days. */
    averageDau30d: number;
    averageDauFrom: string;
    averageDauTo: string;
    /** First UTC day with any recorded heartbeat, null before the first one. */
    trackingSince: string | null;
    trackedFullDays: number;
    generatedAt: string;
};

export type PublicUsageStats = {
    registeredUsers: number;
    activeUsers7d: number;
    activeUsers30d: number;
    /**
     * First UTC day with any heartbeat (null before the first one). While it
     * is less than 7/30 days ago, the 7d/30d numbers cover only the days
     * since then - the landing says so instead of hiding them.
     */
    trackingSince: string | null;
    generatedAt: string;
};

const utcDate = (date: Date): string => date.toISOString().slice(0, 10);
const addDays = (isoDate: string, days: number): string =>
    utcDate(new Date(Date.parse(`${isoDate}T00:00:00Z`) + days * DAY_MS));

let lastPruneAt = 0;

export const pruneActivity = async (now: Date = new Date()): Promise<number> => {
    const cutoff = addDays(utcDate(now), -ACTIVITY_RETENTION_DAYS);
    const result = await pool.query(
        "DELETE FROM companion_activity_days WHERE activity_date < $1::date",
        [cutoff]
    );
    lastPruneAt = now.getTime();
    return result.rowCount ?? 0;
};

/**
 * Records one Companion heartbeat. Idempotent per account per UTC day: any
 * number of heartbeats (or devices) for the same account on the same day is
 * one row. Returns false when the account no longer exists - a still-valid
 * JWT of a deleted user must not be counted.
 */
export const recordCompanionHeartbeat = async (
    streamUserId: number,
    now: Date = new Date()
): Promise<boolean> => {
    const result = await pool.query(
        `INSERT INTO companion_activity_days (stream_user_id, activity_date, last_seen_at)
         SELECT id, ($2::timestamptz AT TIME ZONE 'UTC')::date, $2::timestamptz
           FROM stream_users WHERE id = $1
         ON CONFLICT (stream_user_id, activity_date) DO UPDATE
           SET last_seen_at = GREATEST(companion_activity_days.last_seen_at, EXCLUDED.last_seen_at)
         RETURNING stream_user_id`,
        [streamUserId, now.toISOString()]
    );

    if (now.getTime() - lastPruneAt >= PRUNE_INTERVAL_MS) {
        // Never fails the heartbeat itself - pruning is housekeeping.
        pruneActivity(now).catch((error) =>
            logger.warn("Usage stats prune failed", {
                message: error instanceof Error ? error.message : String(error),
            })
        );
    }

    return (result.rowCount ?? 0) > 0;
};

export const computeUsageStats = async (now: Date = new Date()): Promise<UsageStats> => {
    const nowIso = now.toISOString();
    const today = utcDate(now);
    const averageDauFrom = addDays(today, -AVERAGE_DAU_DAYS);
    const averageDauTo = addDays(today, -1);

    const [registered, rolling, calendar, tracking] = await Promise.all([
        pool.query<{ count: number }>("SELECT COUNT(*)::int AS count FROM stream_users"),
        pool.query<{ dau: number; wau: number; mau: number }>(
            `SELECT
               COUNT(DISTINCT stream_user_id) FILTER (WHERE last_seen_at > $1::timestamptz - INTERVAL '24 hours')::int AS dau,
               COUNT(DISTINCT stream_user_id) FILTER (WHERE last_seen_at > $1::timestamptz - INTERVAL '7 days')::int AS wau,
               COUNT(DISTINCT stream_user_id)::int AS mau
             FROM companion_activity_days
             WHERE last_seen_at > $1::timestamptz - INTERVAL '30 days'
               AND last_seen_at <= $1::timestamptz`,
            [nowIso]
        ),
        // One row per account per day, so COUNT(*) over the range is the
        // sum of the daily distinct-account counts.
        pool.query<{ user_days: number }>(
            `SELECT COUNT(*)::int AS user_days
               FROM companion_activity_days
              WHERE activity_date >= $1::date AND activity_date <= $2::date`,
            [averageDauFrom, averageDauTo]
        ),
        pool.query<{ since: string | null }>(
            "SELECT to_char(MIN(activity_date), 'YYYY-MM-DD') AS since FROM companion_activity_days"
        ),
    ]);

    const trackingSince = tracking.rows[0]?.since ?? null;
    const trackedFullDays = trackingSince
        ? Math.max(0, Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${trackingSince}T00:00:00Z`)) / DAY_MS))
        : 0;

    return {
        registeredUsers: registered.rows[0].count,
        dau: rolling.rows[0].dau,
        wau: rolling.rows[0].wau,
        mau: rolling.rows[0].mau,
        averageDau30d: Math.round((calendar.rows[0].user_days / AVERAGE_DAU_DAYS) * 10) / 10,
        averageDauFrom,
        averageDauTo,
        trackingSince,
        trackedFullDays,
        generatedAt: nowIso,
    };
};

export const toPublicUsageStats = (stats: UsageStats): PublicUsageStats => ({
    registeredUsers: stats.registeredUsers,
    activeUsers7d: stats.wau,
    activeUsers30d: stats.mau,
    trackingSince: stats.trackingSince,
    generatedAt: stats.generatedAt,
});

let publicCache: { value: PublicUsageStats; expiresAt: number } | null = null;
let publicInFlight: Promise<PublicUsageStats> | null = null;

/**
 * Cached aggregate for the public endpoint. Concurrent misses share one
 * query; on a database error a previously computed value is served stale
 * rather than failing (and never replaced by zeros).
 */
export const getPublicUsageStats = async (now: Date = new Date()): Promise<PublicUsageStats> => {
    if (publicCache && publicCache.expiresAt > now.getTime()) return publicCache.value;
    if (publicInFlight) return publicInFlight;

    publicInFlight = computeUsageStats(now)
        .then((stats) => {
            const value = toPublicUsageStats(stats);
            publicCache = { value, expiresAt: now.getTime() + PUBLIC_CACHE_TTL_MS };
            return value;
        })
        .catch((error) => {
            if (publicCache) {
                logger.warn("Usage stats refresh failed, serving stale value", {
                    message: error instanceof Error ? error.message : String(error),
                });
                return publicCache.value;
            }
            throw error;
        })
        .finally(() => {
            publicInFlight = null;
        });
    return publicInFlight;
};

export const resetUsageStatsCacheForTests = () => {
    publicCache = null;
    publicInFlight = null;
    lastPruneAt = 0;
};
