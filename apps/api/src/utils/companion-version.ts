// Desktop Companion sends its own version on every GSI payload
// (companionVersion, see controllers/stream/companion.ts). Companions below
// this floor get a clear "please update" response (426) instead of silently
// accepting a payload shape the backend may no longer understand - see
// WK-59 acceptance criteria ("несовместимость обрабатывается").
//
// Bump this only when an older companion would genuinely misbehave against
// the current backend contract, not on every release.
export const MIN_SUPPORTED_COMPANION_VERSION = "0.4.0";

/**
 * Compares two `x.y.z` version strings. Returns negative if `a` < `b`, 0 if
 * equal, positive if `a` > `b`. Non-numeric/missing segments are treated as
 * 0, matching how Cargo/npm versions are cut for this project (no
 * pre-release/build metadata suffixes in practice).
 */
export function compareVersions(a: string, b: string): number {
    const partsA = a.split(".").map((segment) => Number.parseInt(segment, 10) || 0);
    const partsB = b.split(".").map((segment) => Number.parseInt(segment, 10) || 0);
    const length = Math.max(partsA.length, partsB.length);

    for (let i = 0; i < length; i += 1) {
        const diff = (partsA[i] ?? 0) - (partsB[i] ?? 0);
        if (diff !== 0) {
            return diff;
        }
    }
    return 0;
}

/**
 * `undefined`/unparseable versions are treated as supported - older
 * companions that predate this field, or a malformed value, should never be
 * hard-blocked by a heuristic string compare.
 */
export function isCompanionVersionSupported(
    version: string | null | undefined,
    minVersion: string = MIN_SUPPORTED_COMPANION_VERSION
): boolean {
    if (!version || !/^\d+(\.\d+){0,2}$/.test(version)) {
        return true;
    }
    return compareVersions(version, minVersion) >= 0;
}
