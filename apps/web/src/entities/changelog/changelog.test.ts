import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/shared/config/dota-companion", () => ({ DOTA_COMPANION_VERSION: "0.9.0", DOTA_COMPANION_DOWNLOAD_URL: null }));

import { loadChangelogFeed, pickHighlight } from "./load";
import { parseChangelog } from "./parse";

const companion = `# Prereborn Companion

## 0.10.0 — 2026-10-30 — Ещё не вышло

### Новое
- Будущее.

## 0.9.0 — 2026-10-21 — Статистика

Абзац.

### Новое
- Отметка активности,
  без содержимого.

## 0.8.1 — 2026-10-21 — Исправление

### Исправления
- Плагин.

## 0.8.0 — 2026-10-20 — Битая запись

### Прочее
- Не из формата.
`;
const dota = `# Dota 2

## 0.3.1 — 2026-10-25 — Не в каталоге

### Исправления
- Ещё нет.

## 0.3.0 — 2026-10-21 — Интерфейс

### Улучшения
- Стиль.
`;

describe("parseChangelog", () => {
  it("reads entries and drops malformed ones instead of guessing", () => {
    const entries = parseChangelog(companion);
    expect(entries.map((entry) => entry.version)).toEqual(["0.10.0", "0.9.0", "0.8.1"]);
    expect(entries[1]).toEqual({ version: "0.9.0", date: "2026-10-21", title: "Статистика", summary: "Абзац.", sections: { "Новое": ["Отметка активности, без содержимого."] } });
  });

  it("ignores prerelease versions and bad dates", () => {
    expect(parseChangelog("# P\n## 1.0.0-rc.1 — 2026-10-01 — Бета\n### Новое\n- а\n## 1.0.0 — 2026-02-31x — А\n### Новое\n- а\n")).toEqual([]);
  });
});

describe("loadChangelogFeed", () => {
  afterEach(() => vi.unstubAllGlobals());
  const serve = (files: Record<string, string>) =>
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      const key = Object.keys(files).find((path) => url.endsWith(path));
      return key ? new Response(files[key]) : new Response("", { status: 404 });
    }));

  it("shows only published versions, merged into one newest-first feed", async () => {
    serve({ "/companion.md": companion, "/plugins/dota2.md": dota });
    const feed = await loadChangelogFeed([
      { id: "dota2", name: "Dota 2", description: "", version: "0.3.0" },
      { id: "pubg", name: "PUBG", description: "", version: "0.1.0" },
    ]);
    expect(feed.items.map((item) => `${item.product.id}@${item.version}`)).toEqual(["companion@0.9.0", "companion@0.8.1", "dota2@0.3.0"]);
    expect(feed.products.map((product) => product.id)).toEqual(["companion", "dota2"]);
    expect(feed.complete).toBe(true);
    expect(pickHighlight(feed.items)?.version).toBe("0.9.0");
  });

  it("reports an incomplete feed when a source fails or the catalog is unknown", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("offline"); }));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const feed = await loadChangelogFeed(null);
    expect(feed).toEqual({ items: [], products: [], complete: false });
  });
});
