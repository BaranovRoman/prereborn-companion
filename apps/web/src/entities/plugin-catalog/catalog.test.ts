import { describe, expect, it } from "vitest";
import { parsePluginCatalog } from ".";

const release = (id: string, version: string, extra: Record<string, unknown> = {}) => ({
  manifest: { id, version, name: id.toUpperCase(), description: `${id} ${version}`, platform: "windows", arch: "x86_64", ...extra },
});

describe("parsePluginCatalog", () => {
  it("keeps the newest stable Windows release per plugin, in catalog order", () => {
    const plugins = parsePluginCatalog({
      schema: 1,
      releases: [release("dota2", "0.1.0"), release("dota2", "0.10.0"), release("dota2", "0.9.0"), release("pubg", "0.1.0"), release("pubg", "0.2.0-beta.1"), release("hello", "0.1.0", { platform: "macos" })],
    });
    expect(plugins).toEqual([
      { id: "dota2", name: "DOTA2", description: "dota2 0.10.0", version: "0.10.0" },
      { id: "pubg", name: "PUBG", description: "pubg 0.1.0", version: "0.1.0" },
    ]);
  });

  it("skips malformed releases and rejects a non-catalog body", () => {
    expect(parsePluginCatalog({ releases: [null, { manifest: { id: "../x", version: "1.0.0", name: "X", platform: "windows" } }, release("ok", "1.0.0", { name: "" })] })).toEqual([]);
    expect(parsePluginCatalog({})).toBeNull();
    expect(parsePluginCatalog("nope")).toBeNull();
  });
});
