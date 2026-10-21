import { PLUGIN_CATALOG_URL } from "@/shared/config/product-sources";
import { fetchPublicText } from "@/shared/lib/fetch-public";
import { compareVersions, isStableVersion } from "@/shared/lib/semver";

export type CatalogPlugin = { id: string; name: string; description: string; version: string };

const PLUGIN_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");

/**
 * The newest stable Windows release of every plugin in the official catalog,
 * in catalog order. Malformed releases are skipped, never guessed.
 */
export function parsePluginCatalog(body: unknown): CatalogPlugin[] | null {
  if (!body || typeof body !== "object" || !Array.isArray((body as { releases?: unknown }).releases)) return null;
  const latest = new Map<string, CatalogPlugin>();
  for (const release of (body as { releases: unknown[] }).releases) {
    const manifest = (release as { manifest?: Record<string, unknown> } | null)?.manifest;
    if (!manifest || manifest.platform !== "windows") continue;
    const id = text(manifest.id);
    const version = manifest.version;
    const name = text(manifest.name);
    if (!PLUGIN_ID.test(id) || !isStableVersion(version) || !name) continue;
    const current = latest.get(id);
    if (!current || compareVersions(version, current.version) > 0) latest.set(id, { id, name, description: text(manifest.description), version });
  }
  return [...latest.values()];
}

export type PluginCatalogResult = { ok: true; plugins: CatalogPlugin[] } | { ok: false };

export async function loadPluginCatalog(): Promise<PluginCatalogResult> {
  try {
    const plugins = parsePluginCatalog(JSON.parse(await fetchPublicText(PLUGIN_CATALOG_URL)));
    return plugins ? { ok: true, plugins } : { ok: false };
  } catch (error) {
    console.error("[landing] plugin catalog unavailable:", error);
    return { ok: false };
  }
}
