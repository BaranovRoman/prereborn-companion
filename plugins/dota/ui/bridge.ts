export interface Analysis { sequence: number; broadcastState: "betweenMatches" | "draft" | "gameplay" | "postStream"; soundSignals: { id: string; kind: string }[]; mode: "replay_only"; sideEffects: false }
export function analysis(event: MessageEvent, parent: Window): Analysis | null {
  if (event.source !== parent || event.data?.type !== "dota-replay-result" || event.data.version !== 1) return null;
  const result = event.data.result;
  if (!result || result.mode !== "replay_only" || result.sideEffects !== false || !Number.isSafeInteger(result.sequence) ||
    !["betweenMatches","draft","gameplay","postStream"].includes(result.broadcastState) || !Array.isArray(result.soundSignals)) return null;
  return result;
}
