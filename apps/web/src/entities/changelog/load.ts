import type { CatalogPlugin } from "@/entities/plugin-catalog";
import { CHANGELOG_BASE_URL } from "@/shared/config/product-sources";
import { DOTA_COMPANION_VERSION } from "@/shared/config/dota-companion";
import { HttpStatusError, fetchPublicText } from "@/shared/lib/fetch-public";
import { compareVersions } from "@/shared/lib/semver";
import { parseChangelog, type ChangelogEntry } from "./parse";

export type ChangelogProduct = { kind: "companion" | "plugin"; id: string; name: string };
export type ChangelogItem = ChangelogEntry & { product: ChangelogProduct };
export type ChangelogFeed = { items: ChangelogItem[]; products: ChangelogProduct[]; complete: boolean };

export const COMPANION_PRODUCT: ChangelogProduct = { kind: "companion", id: "companion", name: "Companion" };

/**
 * Entries are shown only once their version is published: Companion up to the
 * stable "latest" release this site was built against, a plugin up to its
 * newest version in the official catalog. An entry merged ahead of its release
 * stays hidden until then.
 */
const published = (entries: ChangelogEntry[], ceiling: string | null) =>
  ceiling ? entries.filter((entry) => compareVersions(entry.version, ceiling) <= 0) : entries;

async function readProduct(product: ChangelogProduct, path: string, ceiling: string | null) {
  try {
    const entries = published(parseChangelog(await fetchPublicText(`${CHANGELOG_BASE_URL}/${path}`)), ceiling);
    return { ok: true as const, items: entries.map((entry) => ({ ...entry, product })) };
  } catch (error) {
    // A plugin without a history file yet simply has no entries; anything else is a load failure.
    if (product.kind === "plugin" && error instanceof HttpStatusError && error.status === 404) return { ok: true as const, items: [] };
    console.error(`[changelog] ${path} unavailable:`, error);
    return { ok: false as const, items: [] };
  }
}

/** Newest first: by date, then Companion before plugins, then by version. */
export const sortFeed = (items: ChangelogItem[]) =>
  [...items].sort((a, b) => b.date.localeCompare(a.date) || Number(a.product.kind === "plugin") - Number(b.product.kind === "plugin") || compareVersions(b.version, a.version));

export async function loadChangelogFeed(plugins: CatalogPlugin[] | null): Promise<ChangelogFeed> {
  const sources: [ChangelogProduct, string, string | null][] = [[COMPANION_PRODUCT, "companion.md", DOTA_COMPANION_VERSION]];
  for (const plugin of plugins ?? []) sources.push([{ kind: "plugin", id: plugin.id, name: plugin.name }, `plugins/${plugin.id}.md`, plugin.version]);
  const results = await Promise.all(sources.map(([product, path, ceiling]) => readProduct(product, path, ceiling)));
  const items = sortFeed(results.flatMap((result) => result.items));
  const products = sources.map(([product]) => product).filter((product) => items.some((item) => item.product.id === product.id));
  return { items, products, complete: plugins !== null && results.every((result) => result.ok) };
}

/** The update the landing highlights: the newest Companion release with something new, else the newest entry. */
export const pickHighlight = (items: ChangelogItem[]): ChangelogItem | null =>
  items.find((item) => item.product.kind === "companion" && item.sections["Новое"]?.length) ?? items[0] ?? null;
