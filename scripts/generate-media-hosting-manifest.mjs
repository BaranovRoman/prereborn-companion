import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const sourceRoot = "apps/web/public/vendor/valve/video";
const mediaSets = ["heroes", "heroes-favorite", "heroes-featured"];
const publicBaseUrl = "https://prereborn.ru/media";
const outputPath = "docs/media/WK-67-media-manifest.tsv";

const entries = (
  await Promise.all(
    mediaSets.map(async (directory) =>
      (await readdir(path.posix.join(sourceRoot, directory)))
        .filter((name) => name.endsWith(".webm"))
        .map((name) => ({ directory, name }))
    )
  )
).flat();
entries.sort((a, b) =>
  path.posix.join(a.directory, a.name).localeCompare(path.posix.join(b.directory, b.name))
);

const rows = await Promise.all(
  entries.map(async ({ directory, name }) => {
    const source = path.posix.join(sourceRoot, directory, name);
    const target = path.posix.join("dota", directory, name);
    const data = await readFile(source);
    const { size } = await stat(source);
    const sha256 = createHash("sha256").update(data).digest("hex");
    return [source, target, `${publicBaseUrl}/${target}`, size, sha256].join("\t");
  })
);

const header = "source\ttarget_relative_to_media_root\tpublic_url\tsize_bytes\tsha256";
await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${header}\n${rows.join("\n")}\n`);

console.log(`Wrote ${entries.length} entries to ${outputPath}`);
