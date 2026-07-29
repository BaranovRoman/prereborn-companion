import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const heroesFile = path.join(root, "apps/web/src/entities/dota-hero/model/heroes.ts");
const outputDir = path.join(root, "apps/web/public/vendor/valve/video/heroes");
const source = await readFile(heroesFile, "utf8");
const names = [...source.matchAll(/name:\s*"([^"]+)"/g)].map((match) => match[1]);
const baseUrl = "https://cdn.cloudflare.steamstatic.com/apps/dota2/videos/dota_react/heroes/renders";

await mkdir(outputDir, { recursive: true });

let cursor = 0;
let downloaded = 0;
let skipped = 0;
const missing = [];

const worker = async () => {
    while (cursor < names.length) {
        const name = names[cursor++];
        const target = path.join(outputDir, `${name}.webm`);
        try {
            if ((await stat(target)).size > 0) {
                skipped++;
                continue;
            }
        } catch {}

        const response = await fetch(`${baseUrl}/${name}.webm`);
        if (!response.ok) {
            missing.push(`${name}: ${response.status}`);
            continue;
        }
        await writeFile(target, Buffer.from(await response.arrayBuffer()));
        downloaded++;
        process.stdout.write(`Downloaded ${name}\n`);
    }
};

await Promise.all(Array.from({ length: 8 }, worker));
console.log(`Done: ${downloaded} downloaded, ${skipped} existing, ${missing.length} unavailable.`);
if (missing.length) console.log(`Unavailable: ${missing.join(", ")}`);
