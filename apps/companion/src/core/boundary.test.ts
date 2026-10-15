import { readFileSync, existsSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const sourceRoot = resolve(import.meta.dirname, "..");

// Follow local imports, including type-only imports, rather than checking
// only the first hop: a shared helper must not reintroduce game contracts.
function localDependencies(entry: string, seen = new Set<string>()): Set<string> {
  if (seen.has(entry)) return seen;
  seen.add(entry);
  const imports = ts.preProcessFile(readFileSync(entry, "utf8"), true).importedFiles;
  for (const { fileName } of imports) {
    if (!fileName.startsWith(".")) continue;
    const base = resolve(dirname(entry), fileName);
    const target = [base + ".ts", base + ".tsx", resolve(base, "index.ts")].find(existsSync);
    if (!target) throw new Error(`Unresolved local import: ${entry} -> ${fileName}`);
    localDependencies(target, seen);
  }
  return seen;
}

describe("core boundary", () => {
  it.each(["core/api.ts", "chat/chat-model.ts", "chat/useTwitchChatSession.ts", "core/audio/playbackRegistry.ts", "core/audio/playbackModel.ts", "core/audio/useManagedPluginAudio.ts"])(
    "%s has no transitive dependency on Dota contracts or the legacy facade",
    (entry) => {
      const files = [...localDependencies(resolve(sourceRoot, entry))];
      expect(files).not.toContain(resolve(sourceRoot, "services/dotaCompanionApi.ts"));
      expect(files).not.toContain(resolve(sourceRoot, "types/status.ts"));
      const paths = files.map((file) => relative(sourceRoot, file).split(sep).join("/"));
      expect(paths.filter((file) => /^(?:dota|overlay|game-sounds)\//.test(file))).toEqual([]);
    },
  );

  it("keeps game bootstrap exclusively behind the built-in adapter", () => {
    const rustRoot = resolve(sourceRoot, "../src-tauri/src");
    const host = readFileSync(resolve(rustRoot, "lib.rs"), "utf8");
    expect(host).toContain(".manage(dota::BuiltInDotaRuntime::default())");
    for (const call of ["dota::initialize(&handle)", "dota::start_ingest(&handle)", "dota::start_workers(&handle)"]) {
      expect(host.split(call)).toHaveLength(2);
    }
    expect(host).not.toMatch(/(?:game_sounds|local_runtime|overlay_server|opendota_overlay_cache|quiz_overlay)::(?:init|start_sweep|start_sync_worker)\(/);
    const transport = readFileSync(resolve(rustRoot, "core/obs_transport.rs"), "utf8");
    expect(transport).not.toMatch(/use crate::|AppState|ObsConfig|BroadcastState|GsiSnapshot/);
  });
});
