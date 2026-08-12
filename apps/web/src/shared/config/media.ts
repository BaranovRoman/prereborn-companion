const DEFAULT_MEDIA_BASE_URL = "/media";

export const MEDIA_BASE_URL = normalizeMediaBaseUrl(
  process.env.NEXT_PUBLIC_MEDIA_BASE_URL || DEFAULT_MEDIA_BASE_URL
);

export function normalizeMediaBaseUrl(value: string): string {
  return value.replace(/\/+$/, "");
}

export function joinMediaUrl(baseUrl: string, path: string): string {
  return `${normalizeMediaBaseUrl(baseUrl)}/${path.replace(/^\/+/, "")}`;
}

export function buildMediaUrl(path: string): string {
  return joinMediaUrl(MEDIA_BASE_URL, path);
}
