#!/usr/bin/env node
// Russian user-facing changelog for Companion and every plugin (format and
// rules: changelog/README.md). The same files feed prereborn.ru/changelog and
// GitHub Release notes, so a release without its entry must not ship.
//
//   node scripts/changelog.mjs check [--companion X.Y.Z] [--plugin <id> X.Y.Z]
//   node scripts/changelog.mjs notes companion X.Y.Z
//   node scripts/changelog.mjs notes plugin <id> X.Y.Z
//
// `check` validates every changelog file and requires an entry for the
// version of each plugins/*/manifest.windows-live.json, so a new plugin is
// covered without extra setup. apps/web/src/entities/changelog/parse.ts
// reads the same format on the site; keep the two in step.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CHANGELOG_DIR = join(ROOT, "changelog");

export const SECTIONS = ["Новое", "Улучшения", "Исправления", "Что сделать после обновления"];
const VERSION_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const HEADER_RE = /^## (\S+) — (\S+) — (.+)$/;
// Developer references that must not stand in for a user-facing description.
const FORBIDDEN = [
  [/\bWK-\d+/i, "номер тикета (WK-…)"],
  [/github\.com\/[^\s)]+\/pull\/\d+/i, "ссылка на PR"],
  [/(^|\s)#\d+\b/, "номер PR (#…)"],
  [/Merge pull request|Full Changelog|What's Changed/i, "текст автоматических release notes"],
];

const compareVersions = (a, b) => {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i += 1) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
};

const isIsoDay = (value) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const time = Date.parse(`${value}T00:00:00Z`);
  return !Number.isNaN(time) && new Date(time).toISOString().startsWith(value);
};

/** Parses one changelog file. Returns { product, entries, errors } and never throws. */
export function parseChangelog(text) {
  const errors = [];
  const entries = [];
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  let product = null;
  let entry = null;
  let section = null;
  const fail = (lineNo, message) => errors.push(`строка ${lineNo}: ${message}`);

  lines.forEach((raw, index) => {
    const lineNo = index + 1;
    const line = raw.trimEnd();
    if (!line.trim()) return;
    if (line.startsWith("# ")) {
      if (product !== null || entries.length) fail(lineNo, "заголовок продукта «# …» допускается один раз, в начале файла");
      else product = line.slice(2).trim();
      return;
    }
    if (product === null) {
      fail(lineNo, "файл должен начинаться с «# <название продукта>»");
      product = "";
    }
    if (line.startsWith("## ")) {
      const match = HEADER_RE.exec(line);
      if (!match) {
        fail(lineNo, "заголовок версии должен быть «## X.Y.Z — ГГГГ-ММ-ДД — Название»");
        entry = null;
        return;
      }
      const [, version, date, title] = match;
      if (!VERSION_RE.test(version)) fail(lineNo, `«${version}» — не stable-версия X.Y.Z`);
      if (!isIsoDay(date)) fail(lineNo, `«${date}» — не дата ГГГГ-ММ-ДД`);
      entry = { version, date, title: title.trim(), summary: [], sections: {}, line: lineNo };
      entries.push(entry);
      section = null;
      return;
    }
    if (!entry) {
      fail(lineNo, "текст до первой версии «## X.Y.Z — …» не допускается");
      return;
    }
    if (line.startsWith("### ")) {
      const name = line.slice(4).trim();
      if (!SECTIONS.includes(name)) fail(lineNo, `раздел «${name}» не из списка: ${SECTIONS.join(", ")}`);
      if (entry.sections[name]) fail(lineNo, `раздел «${name}» повторяется`);
      section = name;
      entry.sections[name] = entry.sections[name] ?? [];
      return;
    }
    if (line.startsWith("#")) {
      fail(lineNo, "допустимы только заголовки «#», «##» и «###»");
      return;
    }
    if (/^\s*[-*] /.test(line)) {
      if (!section) {
        fail(lineNo, "пункт списка вне раздела «### …»");
        return;
      }
      if (/^\s{2,}/.test(line)) fail(lineNo, "вложенные списки не поддерживаются");
      entry.sections[section].push(line.replace(/^\s*[-*] /, "").trim());
      return;
    }
    if (section) {
      // Continuation of the previous bullet (soft-wrapped line).
      const items = entry.sections[section];
      if (!items.length) fail(lineNo, "в разделе ожидается список «- …»");
      else items[items.length - 1] += ` ${line.trim()}`;
      return;
    }
    entry.summary.push(line.trim());
  });

  if (product === null) errors.push("файл пуст");
  else if (!product) errors.push("пустое название продукта");

  const seen = new Set();
  entries.forEach((item, index) => {
    const where = `версия ${item.version} (строка ${item.line})`;
    if (seen.has(item.version)) errors.push(`${where}: версия повторяется`);
    seen.add(item.version);
    const previous = entries[index - 1];
    if (previous && VERSION_RE.test(previous.version) && VERSION_RE.test(item.version) && compareVersions(previous.version, item.version) <= 0)
      errors.push(`${where}: версии должны идти от новой к старой`);
    const items = Object.values(item.sections).flat();
    if (!items.length) errors.push(`${where}: нет ни одного пункта в разделах ${SECTIONS.join(", ")}`);
    for (const [name, list] of Object.entries(item.sections)) if (!list.length) errors.push(`${where}: раздел «${name}» пуст`);
    const text = [item.title, ...item.summary, ...items].join("\n");
    if (!/[А-Яа-яЁё]/.test(text)) errors.push(`${where}: запись должна быть на русском языке`);
    for (const [re, label] of FORBIDDEN) if (re.test(text)) errors.push(`${where}: не используйте ${label} — опишите изменение для пользователя`);
  });

  return { product, entries: entries.map(({ line, ...rest }) => rest), errors };
}

/** GitHub Release body for one entry (Markdown). */
export function renderNotes(entry) {
  const out = [`## ${entry.title}`, ""];
  if (entry.summary.length) out.push(entry.summary.join(" "), "");
  for (const name of SECTIONS) {
    const items = entry.sections[name];
    if (!items?.length) continue;
    out.push(`### ${name}`, ...items.map((item) => `- ${item}`), "");
  }
  out.push("_История всех обновлений: https://prereborn.ru/changelog_");
  return `${out.join("\n")}\n`;
}

const changelogPath = (product, pluginId) =>
  product === "companion" ? join(CHANGELOG_DIR, "companion.md") : join(CHANGELOG_DIR, "plugins", `${pluginId}.md`);

const readParsed = (path) => (existsSync(path) ? parseChangelog(readFileSync(path, "utf8")) : null);

const findEntry = (product, pluginId, version) => {
  const path = changelogPath(product, pluginId);
  const label = product === "companion" ? "Companion" : `плагина ${pluginId}`;
  const parsed = readParsed(path);
  if (!parsed) return { error: `Нет файла ${relative(ROOT, path)} — добавьте историю ${label} (changelog/README.md).` };
  if (parsed.errors.length) return { error: `${relative(ROOT, path)}:\n  ${parsed.errors.join("\n  ")}` };
  const entry = parsed.entries.find((item) => item.version === version);
  if (!entry) return { error: `В ${relative(ROOT, path)} нет записи для версии ${version} ${label}. Релиз без записи в changelog не завершён (changelog/README.md).` };
  return { entry };
};

/** Plugins that ship a live Windows manifest: [{ id, version, manifest }]. */
export function publishablePlugins(root = ROOT) {
  const dir = join(root, "plugins");
  return readdirSync(dir, { withFileTypes: true })
    .filter((item) => item.isDirectory())
    .map((item) => join(dir, item.name, "manifest.windows-live.json"))
    .filter((path) => existsSync(path))
    .map((path) => {
      const manifest = JSON.parse(readFileSync(path, "utf8"));
      return { id: manifest.id, version: manifest.version, manifest: relative(root, path) };
    });
}

function check(args) {
  const problems = [];
  const files = [join(CHANGELOG_DIR, "companion.md")];
  const pluginDir = join(CHANGELOG_DIR, "plugins");
  if (existsSync(pluginDir)) for (const name of readdirSync(pluginDir)) if (name.endsWith(".md")) files.push(join(pluginDir, name));
  for (const path of files) {
    const parsed = readParsed(path);
    if (!parsed) problems.push(`Нет файла ${relative(ROOT, path)}.`);
    else if (parsed.errors.length) problems.push(`${relative(ROOT, path)}:\n  ${parsed.errors.join("\n  ")}`);
  }
  const required = publishablePlugins().map(({ id, version }) => ["plugin", id, version]);
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--companion" && args[i + 1]) required.push(["companion", null, args[(i += 1)]]);
    else if (args[i] === "--plugin" && args[i + 1] && args[i + 2]) required.push(["plugin", args[(i += 1)], args[(i += 1)]]);
    else throw new Error(`Неизвестный аргумент: ${args[i]}`);
  }
  for (const [product, id, version] of required) {
    if (!VERSION_RE.test(version)) problems.push(`«${version}» — не stable-версия X.Y.Z.`);
    else {
      const { error } = findEntry(product, id, version);
      if (error && !problems.includes(error)) problems.push(error);
    }
  }
  if (problems.length) {
    console.error(`Changelog: ошибки (${problems.length})\n${problems.map((p) => `- ${p}`).join("\n")}`);
    process.exit(1);
  }
  console.log(`Changelog OK: ${files.length} файл(ов), проверено версий: ${required.length}.`);
}

function notes(args) {
  const [product, ...rest] = args;
  const [pluginId, version] = product === "plugin" ? rest : [null, rest[0]];
  if (!["companion", "plugin"].includes(product) || !version || (product === "plugin" && !pluginId))
    throw new Error("Использование: notes companion X.Y.Z | notes plugin <id> X.Y.Z");
  const { entry, error } = findEntry(product, pluginId, version);
  if (error) {
    console.error(error);
    process.exit(1);
  }
  process.stdout.write(renderNotes(entry));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [command, ...args] = process.argv.slice(2);
  try {
    if (command === "check") check(args);
    else if (command === "notes") notes(args);
    else throw new Error("Команды: check, notes (см. changelog/README.md)");
  } catch (error) {
    console.error(error.message);
    process.exit(2);
  }
}
