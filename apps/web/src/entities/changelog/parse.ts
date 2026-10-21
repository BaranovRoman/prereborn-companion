import { isStableVersion } from "@/shared/lib/semver";

// Reader for the changelog files format (changelog/README.md on the release
// branch). scripts/changelog.mjs there is the strict validator CI runs; this
// side is lenient and keeps only well-formed entries, so a broken line can
// never show invented content.

export const CHANGELOG_SECTIONS = ["Новое", "Улучшения", "Исправления", "Что сделать после обновления"] as const;
export type ChangelogSection = (typeof CHANGELOG_SECTIONS)[number];

export type ChangelogEntry = {
  version: string;
  date: string;
  title: string;
  summary: string;
  sections: Partial<Record<ChangelogSection, string[]>>;
};

const HEADER = /^## (\S+) — (\d{4}-\d{2}-\d{2}) — (.+)$/;
const isSection = (name: string): name is ChangelogSection => (CHANGELOG_SECTIONS as readonly string[]).includes(name);
const isDay = (value: string) => !Number.isNaN(Date.parse(`${value}T00:00:00Z`));

export function parseChangelog(text: string): ChangelogEntry[] {
  const entries: (ChangelogEntry & { broken?: boolean })[] = [];
  let entry: (ChangelogEntry & { broken?: boolean }) | null = null;
  let section: ChangelogSection | null = null;
  const summary: string[] = [];

  const close = () => {
    if (entry) entry.summary = summary.splice(0).join(" ");
  };

  for (const raw of text.replace(/\r\n/g, "\n").split("\n")) {
    const line = raw.trimEnd();
    if (!line.trim() || line.startsWith("# ")) continue;
    if (line.startsWith("## ")) {
      close();
      const match = HEADER.exec(line);
      entry = match && isStableVersion(match[1]) && isDay(match[2]) ? { version: match[1], date: match[2], title: match[3].trim(), summary: "", sections: {} } : null;
      if (entry) entries.push(entry);
      section = null;
      continue;
    }
    if (!entry) continue;
    if (line.startsWith("### ")) {
      const name = line.slice(4).trim();
      section = isSection(name) ? name : null;
      if (section) entry.sections[section] = entry.sections[section] ?? [];
      else entry.broken = true;
      continue;
    }
    if (/^[-*] /.test(line)) {
      if (section) entry.sections[section]!.push(line.slice(2).trim());
      else entry.broken = true;
      continue;
    }
    if (section) {
      const items = entry.sections[section]!;
      if (items.length) items[items.length - 1] += ` ${line.trim()}`;
      continue;
    }
    summary.push(line.trim());
  }
  close();

  return entries
    .filter((item) => !item.broken && Object.values(item.sections).some((list) => list && list.length))
    .map(({ version, date, title, summary: text, sections }) => ({ version, date, title, summary: text, sections }));
}
