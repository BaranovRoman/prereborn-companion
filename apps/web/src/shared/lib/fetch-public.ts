import { PUBLIC_DATA_REVALIDATE_SECONDS } from "@/shared/config/product-sources";

export class HttpStatusError extends Error {
  constructor(readonly status: number, url: string) {
    super(`HTTP ${status} for ${url}`);
  }
}

/**
 * Server-side GET of public release data, kept in Next's data cache so
 * visitors never wait on GitHub; a failed refresh keeps serving the last
 * cached copy.
 */
export async function fetchPublicText(url: string): Promise<string> {
  const res = await fetch(url, {
    next: { revalidate: PUBLIC_DATA_REVALIDATE_SECONDS },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new HttpStatusError(res.status, url);
  return res.text();
}
