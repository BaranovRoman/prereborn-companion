import { useEffect, useRef, useState } from "react";
import { getRuntimeHealth } from "../services/dotaCompanionApi";

const HEALTH_URL = "http://127.0.0.1:3666/overlay/health";
const PER_ATTEMPT_TIMEOUT_MS = 1_500;
const BACKOFF_BASE_MS = 400;
const BACKOFF_CAP_MS = 5_000;
// Attempts before the UI says anything is wrong (~30s worst case) - not a
// hard ceiling. Polling keeps going at BACKOFF_CAP_MS after this, see below.
const ATTEMPTS_BEFORE_SURFACING_ERROR = 12;

const OBS_REFRESH_HINT =
  "Если источник в OBS (Browser Source) не обновился сам, обновите его вручную: ПКМ по источнику → «Обновить».";

// WK-152 - root cause of "Оформление preview sometimes doesn't load": the
// preview iframe used to mount unconditionally, pointed at the local
// overlay HTTP server (127.0.0.1:3666), with no readiness check. That
// server binds its port through its own bind-retry loop (see
// overlay_server.rs), so a cold app start or a momentarily-busy port raced
// the iframe's very first navigation against the server actually being up
// yet - and once that first navigation hit connection-refused, nothing
// ever remounted it (its `key` only changes on tab switch), leaving it
// broken until the user happened to switch tabs.
//
// Fix: never set the iframe `src` until a real readiness probe against the
// server's existing `/overlay/health` endpoint succeeds. Bounded exponential
// backoff, not an arbitrary sleep - each attempt has its own short timeout
// (AbortController) so a hung request can't stall the next retry.
//
// WK-153 P0 - production regression fix: this used to give up FOR GOOD
// after ATTEMPTS_BEFORE_SURFACING_ERROR attempts, with a hardcoded
// "проверьте что Companion запущен" message - nonsensical copy (the user
// reading it is demonstrably already inside a running Companion) attached
// to a poll that had permanently stopped, even though the Rust bind-retry
// loop underneath (overlay_server.rs's own `init`) never gives up and can
// still succeed seconds later (a slow cold start, a port that was briefly
// held by the previous process on restart, ...). Two changes:
//  1. Polling never permanently stops - it keeps retrying at the capped
//     interval indefinitely, exactly like the Rust side does, so the
//     preview (and this hook's `ready`) self-heals the moment the server
//     actually binds, without requiring the user to notice and click
//     "Повторить".
//  2. The message shown once attempts pass the threshold is built from
//     `get_runtime_health`'s `localRuntime.overlayServer` component - a
//     Tauri IPC call answered by the always-running Companion process
//     itself, independent of the very HTTP server this hook is probing -
//     so it can report the REAL reason (port occupied, OS bind error, the
//     server hasn't attempted a bind yet, ...) instead of guessing from a
//     bare fetch failure.
function buildFailureMessage(reason: string | null | undefined): string {
  const detail = reason ? `: ${reason}` : "";
  return `Локальный оверлей не запустился${detail}. Companion продолжает попытки автоматически — окно обновится само. ${OBS_REFRESH_HINT}`;
}

async function describeOverlayFailure(): Promise<string> {
  try {
    const health = await getRuntimeHealth();
    return buildFailureMessage(health.localRuntime.overlayServer.reason);
  } catch {
    return buildFailureMessage(null);
  }
}

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
          setError(null);
        })
        .catch(() => {
          if (cancelled) return;
          if (attemptRef.current === ATTEMPTS_BEFORE_SURFACING_ERROR) {
            void describeOverlayFailure().then((message) => {
              if (!cancelled) setError(message);
            });
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
