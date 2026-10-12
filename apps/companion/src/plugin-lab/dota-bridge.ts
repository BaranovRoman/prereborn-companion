export function replayRequest(event: MessageEvent, source: Window | null): unknown | null {
  if (!source || event.source !== source || event.data?.type !== "dota-replay-request" || event.data.version !== 1) return null;
  const input = event.data.input;
  try { if (!input || typeof input !== "object" || new TextEncoder().encode(JSON.stringify(input)).length > 60000) return null; }
  catch { return null; }
  return input;
}
