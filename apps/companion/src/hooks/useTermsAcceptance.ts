import { useCallback, useEffect, useState } from "react";
import * as api from "../services/dotaCompanionApi";

// WK-191 - polls whether the signed-in account still has to accept the user
// agreement. A minute is enough to pick up a sign-in made in Settings, and is
// negligible next to the chat poll. Any failure (not signed in, offline)
// means "nothing to show": the banner never gets in the way of the app.
const POLL_MS = 60_000;

export function useTermsAcceptance() {
  const [status, setStatus] = useState<api.TermsStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setStatus(await api.getTermsStatus());
    } catch {
      setStatus(null);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), POLL_MS);
    return () => window.clearInterval(timer);
  }, [load]);

  const accept = useCallback(async () => {
    if (!status?.currentVersion) return;
    setBusy(true);
    setError(null);
    try {
      setStatus(await api.acceptTerms(status.currentVersion));
    } catch (cause) {
      setError(String(cause));
      void load();
    } finally {
      setBusy(false);
    }
  }, [status, load]);

  return {
    required: Boolean(status?.acceptanceRequired && status.currentVersion),
    version: status?.currentVersion ?? null,
    busy,
    error,
    accept,
  };
}
