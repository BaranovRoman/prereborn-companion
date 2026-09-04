import { useEffect, useRef, useState } from "react";

const HEALTH_URL = "http://127.0.0.1:3666/overlay/health";
const PER_ATTEMPT_TIMEOUT_MS = 1_500;
const BACKOFF_BASE_MS = 400;
const BACKOFF_CAP_MS = 5_000;
const MAX_ATTEMPTS = 12; // ~30s worst case (matches overlay_server.rs's own bind-retry cap)

// WK-152 - root cause of "Оформление preview sometimes doesn't load": the
// preview iframe used to mount unconditionally, pointed at the local
// overlay HTTP server (127.0.0.1:3666), with no readiness check. That
// server binds its port through its own bind-retry loop (up to a 30s
// backoff cap - see overlay_server.rs), so a cold app start or a
// momentarily-busy port raced the iframe's very first navigation against
// the server actually being up yet - and once that first navigation hit
// connection-refused, nothing ever remounted the iframe (its `key` only
// changes on tab switch), leaving it broken until the user happened to
// switch tabs.
//
// Fix: never set the iframe `src` until a real readiness probe against the
// server's existing `/overlay/health` endpoint succeeds. Bounded exponential
// backoff, not an arbitrary sleep - each attempt has its own short timeout
// (AbortController) so a hung request can't stall the next retry, and
// polling stops after MAX_ATTEMPTS with an explicit error + manual retry
// rather than looping forever.
export function useLocalOverlayPreviewReady() {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retryToken, setRetryToken] = useState(0);
  const attemptRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    attemptRef.current = 0;
    setReady(false);
    setError(null);

    const attempt = () => {
      if (cancelled) return;
      attemptRef.current += 1;
      const controller = new AbortController();
      const abortTimer = setTimeout(() => controller.abort(), PER_ATTEMPT_TIMEOUT_MS);
      fetch(HEALTH_URL, { signal: controller.signal })
        .then((response) => {
          if (cancelled) return;
          if (!response.ok) throw new Error(`overlay health responded ${response.status}`);
          setReady(true);
        })
        .catch(() => {
          if (cancelled) return;
          if (attemptRef.current >= MAX_ATTEMPTS) {
            setError("Локальный оверлей не отвечает. Проверьте, что Companion запущен, и повторите попытку.");
            return;
          }
          const delay = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** (attemptRef.current - 1));
          timer = setTimeout(attempt, delay);
        })
        .finally(() => clearTimeout(abortTimer));
    };

    attempt();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [retryToken]);

  const retry = () => setRetryToken((token) => token + 1);

  return { ready, error, retry };
}
