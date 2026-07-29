const fallback = "http://localhost:3000";
export const SITE_URL = (process.env.NEXT_PUBLIC_SITE_URL || fallback).replace(/\/+$/, "");
export const SITE_NAME = "PreReborn Companion";
export const siteUrl = (path = "/"): string =>
  `${SITE_URL}${path.startsWith("/") ? path : `/${path}`}`;

