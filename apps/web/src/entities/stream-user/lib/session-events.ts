// WK-189 - the session lives in localStorage (lib/tokens.ts), so pages and
// the public header learn about login/logout from events: a custom event in
// this tab and the native `storage` event from other tabs.
export const SESSION_CHANGED_EVENT = "prereborn:session-changed";

export const notifySessionChanged = (): void => {
    if (typeof window !== "undefined") window.dispatchEvent(new Event(SESSION_CHANGED_EVENT));
};

export const subscribeToSessionChanges = (onChange: () => void): (() => void) => {
    const onStorage = (event: StorageEvent) => {
        if (event.key === null || event.key.startsWith("stream_")) onChange();
    };
    window.addEventListener(SESSION_CHANGED_EVENT, onChange);
    window.addEventListener("storage", onStorage);
    return () => {
        window.removeEventListener(SESSION_CHANGED_EVENT, onChange);
        window.removeEventListener("storage", onStorage);
    };
};

// Pages that need a signed-in user. Elsewhere (landing, /changelog) an
// expired session silently becomes a guest session.
const PROTECTED_PREFIXES = ["/account", "/admin", "/stream"];

export const isProtectedPath = (pathname: string): boolean =>
    PROTECTED_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));

// Where the login form may send the user back to (no open redirects).
export const safeNextPath = (raw: string | null, fallback = "/account"): string =>
    raw && raw.startsWith("/") && !raw.startsWith("//") && isProtectedPath(raw.split("?")[0]) ? raw : fallback;
