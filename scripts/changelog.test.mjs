// node --test scripts/changelog.test.mjs
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { parseChangelog, publishablePlugins, renderNotes } from "./changelog.mjs";

const valid = `# Prereborn Companion

## 0.2.0 — 2026-10-21 — Клипы

Короткое описание.

### Новое
- Клип по горячей клавише,
  даже когда игра открыта.

### Что сделать после обновления
- Переподключите Twitch.

## 0.1.0 — 2026-10-01 — Первый выпуск

### Исправления
- Чат больше не пропадает.
`;

test("parses entries, sections, summary and wrapped bullets", () => {
  const { product, entries, errors } = parseChangelog(valid);
  assert.deepEqual(errors, []);
  assert.equal(product, "Prereborn Companion");
  assert.equal(entries.length, 2);
  assert.deepEqual(entries[0], {
    version: "0.2.0", date: "2026-10-21", title: "Клипы", summary: ["Короткое описание."],
    sections: { "Новое": ["Клип по горячей клавише, даже когда игра открыта."], "Что сделать после обновления": ["Переподключите Twitch."] },
  });
});

const errorsOf = (text) => parseChangelog(text).errors.join("\n");

test("rejects malformed headers, unknown sections and empty entries", () => {
  assert.match(errorsOf("# P\n\n## 0.1.0 - 2026-10-01 - Плохо\n### Новое\n- а\n"), /заголовок версии/);
  assert.match(errorsOf("# P\n\n## 0.1.0-rc.1 — 2026-10-01 — Бета\n### Новое\n- а\n"), /не stable-версия/);
  assert.match(errorsOf("# P\n\n## 0.1.0 — 2026-13-01 — Дата\n### Новое\n- а\n"), /не дата/);
  assert.match(errorsOf("# P\n\n## 0.1.0 — 2026-10-01 — Что-то\n### Прочее\n- а\n"), /не из списка/);
  assert.match(errorsOf("# P\n\n## 0.1.0 — 2026-10-01 — Пусто\n"), /нет ни одного пункта/);
});

test("requires newest-first unique versions", () => {
  const body = "### Новое\n- а\n";
  assert.match(errorsOf(`# P\n## 0.1.0 — 2026-10-01 — А\n${body}## 0.2.0 — 2026-10-02 — Б\n${body}`), /от новой к старой/);
  assert.match(errorsOf(`# P\n## 0.1.0 — 2026-10-01 — А\n${body}## 0.1.0 — 2026-10-01 — А\n${body}`), /повторяется/);
});

test("rejects commit/PR/ticket text and non-Russian entries", () => {
  assert.match(errorsOf("# P\n## 0.1.0 — 2026-10-01 — Клипы (WK-178)\n### Новое\n- а\n"), /номер тикета/);
  assert.match(errorsOf("# P\n## 0.1.0 — 2026-10-01 — Клипы\n### Новое\n- см. #136\n"), /номер PR/);
  assert.match(errorsOf("# P\n## 0.1.0 — 2026-10-01 — Clips\n### Новое\n- Twitch clips on a hotkey\n"), /на русском/);
});

test("renders GitHub release notes from an entry", () => {
  const notes = renderNotes(parseChangelog(valid).entries[0]);
  assert.match(notes, /^## Клипы\n\nКороткое описание\.\n\n### Новое\n- Клип по горячей клавише/);
  assert.match(notes, /### Что сделать после обновления\n- Переподключите Twitch\./);
  assert.match(notes, /prereborn\.ru\/changelog/);
});

test("repository changelog is valid and covers every publishable plugin version", () => {
  assert.ok(publishablePlugins().length >= 1);
  const out = execFileSync(process.execPath, ["scripts/changelog.mjs", "check"], { encoding: "utf8" });
  assert.match(out, /Changelog OK/);
});

test("missing entry fails the release gate", () => {
  assert.throws(() => execFileSync(process.execPath, ["scripts/changelog.mjs", "check", "--companion", "99.0.0"], { stdio: "pipe" }), (error) => {
    assert.match(String(error.stderr), /нет записи для версии 99\.0\.0/);
    return true;
  });
  assert.throws(() => execFileSync(process.execPath, ["scripts/changelog.mjs", "notes", "plugin", "no-such-plugin", "0.1.0"], { stdio: "pipe" }), /Нет файла|no-such-plugin/);
});
