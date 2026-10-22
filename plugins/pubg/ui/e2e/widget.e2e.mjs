// Whole chain of the OBS widget (WK-183 follow-up): a finished match given
// to the real worker (as the backend reply) → its loopback server → the built
// page at /pubg/widget in Chromium (the engine of OBS Browser Source), with
// no reload of the page or restart of the worker in between.
// Needs `pnpm build` first (dist/widget/index.html) and cargo.
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { chromium } from "@playwright/test";

const ui = fileURLToPath(new URL("..", import.meta.url));
const renderer = fileURLToPath(new URL("../dist/widget/index.html", import.meta.url));
let harness, lines, browser, url, sessionStart;

const read = async () => { const [line] = await once(lines, "line"); return JSON.parse(line); };
const send = async (input) => { harness.stdin.write(`${JSON.stringify(input)}\n`); return read(); };
const minutes = (n) => new Date(sessionStart.getTime() + n * 60_000).toISOString();
const match = (n, startedAtMinute) => ({
  id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`, createdAt: minutes(startedAtMinute),
  durationSec: 1700, map: n % 2 ? "Erangel" : "Miramar", gameMode: "squad-fpp", place: n, kills: n, damage: 100 * n,
});
const widget = { enabled: true, count: 5, scale: 100, backgroundOpacity: 70, showHeaders: true };
const player = { player: "ProPlayer", platform: "steam" };
async function open({ obs }) {
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  if (obs) await page.addInitScript(() => { window.obsstudio = { pluginVersion: "e2e" }; });
  await page.goto(url);
  return { page, errors };
}
const rows = (page) => page.locator("table.pubg-widget tbody tr");

before(async () => {
  harness = spawn("cargo", ["run", "--quiet", "--manifest-path", "../../Cargo.toml", "-p", "companion-pubg-plugin",
    "--features", "harness", "--example", "widget_harness", "--", renderer], { cwd: ui, stdio: ["pipe", "pipe", "inherit"] });
  lines = createInterface({ input: harness.stdout });
  ({ url, sessionStartedAt: sessionStart } = await read());
  sessionStart = new Date(sessionStart);
  browser = await chromium.launch();
});
after(async () => { await browser?.close(); harness?.stdin.end(); if (harness) await once(harness, "exit"); });

test("a finished match appears in the open OBS page without reload or restart", { timeout: 60_000 }, async () => {
  const response = await fetch(url);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /^text\/html/);
  const html = await response.text();
  assert.match(html, /<script type="module"[^>]*>/, "self-contained renderer, no external JS/CSS");
  assert.doesNotMatch(html, /<script[^>]+src=|<link[^>]+stylesheet/);

  const browserTab = await open({ obs: false });
  const obs = await open({ obs: true });
  // Default settings: the widget is off; the browser says so, OBS is blank.
  await send({ settings: { ...player, widget: { ...widget, enabled: false } } });
  await browserTab.page.getByRole("status").getByText("Виджет выключен").waitFor();
  assert.equal(await obs.page.locator("#root").innerText(), "");

  await send({ settings: { ...player, widget } });
  await browserTab.page.getByText("ещё нет завершённых матчей").waitFor();
  // A match from the previous session (finished before start) never shows.
  await send({ matches: [match(1, -120)] });

  // Running when the plugin started, finished after it, result arrives now.
  await send({ matches: [match(2, -10), match(1, -120)] });
  for (const { page } of [browserTab, obs]) {
    await rows(page).first().waitFor({ timeout: 5000 });
    assert.deepEqual(await rows(page).allInnerTexts(), ["Miramar\t#2\t2\t200"]);
  }
  // Really visible: sized, opaque text, not clipped away by the container.
  const box = await rows(obs.page).first().boundingBox();
  assert.ok(box && box.width > 100 && box.height > 10, JSON.stringify(box));
  const style = await obs.page.locator("table.pubg-widget").evaluate((el) => {
    const s = getComputedStyle(el); const cell = getComputedStyle(el.querySelector("td"));
    return { opacity: s.opacity, visibility: s.visibility, display: s.display, color: cell.color, fontSize: parseFloat(cell.fontSize) };
  });
  assert.deepEqual({ ...style, fontSize: style.fontSize >= 12 }, { opacity: "1", visibility: "visible", display: "table", color: "rgb(242, 244, 247)", fontSize: true });

  // The next match finishes: same page, same worker, a second row on top.
  await send({ matches: [match(3, 30), match(2, -10), match(1, -120)] });
  await obs.page.waitForFunction(() => document.querySelectorAll("table.pubg-widget tbody tr").length === 2, null, { timeout: 5000 });
  assert.deepEqual(await rows(obs.page).allInnerTexts(), ["Erangel\t#3\t3\t300", "Miramar\t#2\t2\t200"]);

  assert.deepEqual([...browserTab.errors, ...obs.errors], []);
});
