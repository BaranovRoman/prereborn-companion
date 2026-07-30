import {
    openDotaMatchProvider,
    type DotaPlayerProfile,
} from "./dota-match-provider.js";

const PROFILE_TTL_MS = 5 * 60_000;

interface CacheEntry {
    expiresAt: number;
    profile: DotaPlayerProfile | null;
}

const cache = new Map<number, CacheEntry>();
const inFlight = new Map<number, Promise<DotaPlayerProfile | null>>();

export const getCachedSteamProfile = async (
    dotaAccountId: number
): Promise<DotaPlayerProfile | null> => {
    const cached = cache.get(dotaAccountId);
    if (cached && cached.expiresAt > Date.now()) return cached.profile;

    if (inFlight.has(dotaAccountId)) return null;

    const request = openDotaMatchProvider
        .getPlayerProfile(dotaAccountId)
        .then((result) => {
            const profile = result.status === "ok" ? result.profile : null;
            cache.set(dotaAccountId, {
                profile,
                expiresAt: Date.now() + PROFILE_TTL_MS,
            });
            return profile;
        })
        .catch(() => null)
        .finally(() => {
            inFlight.delete(dotaAccountId);
        });

    inFlight.set(dotaAccountId, request);
    // The public overlay must never wait on OpenDota. On a cold cache the
    // profile is filled in the background and appears on the next poll.
    return null;
};
