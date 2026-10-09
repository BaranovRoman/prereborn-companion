export function greeting(event: MessageEvent, source: Window | null): string | null {
  if (!source || event.source !== source || event.data?.type !== "hello-greet" || typeof event.data.text !== "string") return null;
  return event.data.text.slice(0, 100);
}
