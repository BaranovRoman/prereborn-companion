// Captures every Companion page and Dota plugin tab at the QA viewports and
// reports layout problems (competing vertical scrollbars, horizontal overflow).
// Usage (servers from qa/README.md running):
//   PLAYWRIGHT=<path to playwright package> node apps/companion/qa/screenshots.mjs <outDir> [viewport...]
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const { chromium } = await import(process.env.PLAYWRIGHT ?? "playwright");
const out = process.argv[2] ?? "qa-shots";
const sizes = (process.argv.slice(3).length ? process.argv.slice(3) : ["1920x1080", "2560x1440", "1280x720", "1024x720"])
  .map((s) => s.split("x").map(Number));
const scenarios = (process.env.SCENARIOS ?? "default").split(",");
const base = process.env.QA_URL ?? "http://localhost:1430/";
mkdirSync(out, { recursive: true });

const pages = [["overview", "Обзор"], ["chat", "Чат"], ["speech", "Озвучка"], ["obs", "OBS"], ["plugins", "Плагины"], ["settings", "Настройки"]];
const dotaTabs = [["heroes", "Герои"], ["items", "Предметы"], ["history", "История"], ["obs", "OBS и сцены"], ["overlay", "Overlay"], ["settings", "Настройки"]];

// Every element that currently shows its own vertical scrollbar (document included).
const scrollers = () => {
  const found = [];
  const doc = document.scrollingElement;
  if (doc && doc.scrollHeight > doc.clientHeight + 1) found.push("document");
  for (const el of document.querySelectorAll("*")) {
    const style = getComputedStyle(el);
    if (!["auto", "scroll"].includes(style.overflowY)) continue;
    if (el.scrollHeight > el.clientHeight + 1 && el.clientHeight > 0) found.push(el.className || el.tagName);
  }
  return { scrollers: found, horizontal: doc ? doc.scrollWidth > doc.clientWidth + 1 : false };
};

const browser = await chromium.launch();
const report = [];
for (const scenario of scenarios) for (const [w, h] of sizes) {
  const page = await browser.newPage({ viewport: { width: w, height: h } });
  await page.goto(`${base}?scenario=${scenario}`);
  await page.waitForTimeout(800);
  const tag = `${scenario}-${w}x${h}`;
  for (const [id, label] of pages) {
    await page.getByRole("navigation", { name: "Разделы приложения" }).getByRole("button", { name: label }).click();
    await page.waitForTimeout(500);
    if (id === "plugins") {
      await page.screenshot({ path: join(out, `${tag}-plugins.png`) });
      report.push({ shot: `${tag}-plugins`, ...(await page.evaluate(scrollers)) });
      const open = page.getByRole("button", { name: "Открыть" }).first();
      if (!(await open.count())) continue;
      await open.click();
      const frame = page.frameLocator("iframe[title='Dota 2']");
      await frame.getByRole("navigation", { name: "Разделы Dota" }).waitFor({ timeout: 10000 }).catch(() => {});
      for (const [tab, tabLabel] of dotaTabs) {
        await frame.getByRole("navigation", { name: "Разделы Dota" }).getByRole("button", { name: tabLabel }).click().catch(() => {});
        await page.waitForTimeout(tab === "overlay" ? 2500 : 1200);
        await page.screenshot({ path: join(out, `${tag}-dota-${tab}.png`) });
        const inner = await page.frames().find((f) => f.url().includes("/plugin-ui/dota/"))?.evaluate(scrollers).catch(() => null);
        report.push({ shot: `${tag}-dota-${tab}`, ...(await page.evaluate(scrollers)), plugin: inner });
        if (tab === "overlay") {
          await frame.getByRole("tab", { name: "Игра" }).click().catch(() => {});
          await page.waitForTimeout(2500);
          await page.screenshot({ path: join(out, `${tag}-dota-overlay-gameplay.png`) });
          await page.frames().find((f) => f.url().includes("/plugin-ui/dota/"))?.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
          await page.waitForTimeout(500);
          await page.screenshot({ path: join(out, `${tag}-dota-overlay-gameplay-scrolled.png`) });
          await page.frames().find((f) => f.url().includes("/plugin-ui/dota/"))?.evaluate(() => window.scrollTo(0, 0));
        }
      }
      await page.getByRole("button", { name: "Все плагины" }).first().click();
      continue;
    }
    await page.screenshot({ path: join(out, `${tag}-${id}.png`) });
    report.push({ shot: `${tag}-${id}`, ...(await page.evaluate(scrollers)) });
  }
  await page.close();
}
await browser.close();
writeFileSync(join(out, "layout-report.json"), JSON.stringify(report, null, 2));
for (const r of report) {
  const outer = r.scrollers.length + (r.plugin?.scrollers.length ?? 0);
  if (outer > 1 || r.horizontal || r.plugin?.horizontal) console.log("CHECK", r.shot, JSON.stringify({ host: r.scrollers, plugin: r.plugin?.scrollers, h: r.horizontal || r.plugin?.horizontal }));
}
console.log(`${report.length} screenshots in ${out}`);
