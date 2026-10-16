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

  it("ships core without a built-in game bootstrap or game Cargo dependencies", () => {
    const nativeRoot=resolve(sourceRoot,"../src-tauri");
    const host=readFileSync(resolve(nativeRoot,"src/lib.rs"),"utf8");
    expect(host).not.toMatch(/BuiltInDotaRuntime|(?:dota|game_sounds|local_runtime|overlay_server|server)::(?:initialize|start|init)/);
    expect(readFileSync(resolve(nativeRoot,"Cargo.toml"),"utf8")).not.toMatch(/^companion-dota-/m);
    for(const removed of ["src/dota/mod.rs","src/server/mod.rs","src/game_sounds/mod.rs","src/overlay_server.rs","src/local_runtime/mod.rs"]){expect(existsSync(resolve(nativeRoot,removed))).toBe(false);}
    const transport=readFileSync(resolve(nativeRoot,"src/core/obs_transport.rs"),"utf8");
    expect(transport).not.toMatch(/companion_dota|BroadcastState|GsiSnapshot/);
  });
});
