import { beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { action } from "./api";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
beforeEach(() => vi.clearAllMocks());

it("sends the exact preparation command and propagates native rejection", async () => {
  vi.mocked(invoke).mockRejectedValue("backup_already_exists");
  await expect(action("installed-plugin","prepare")).rejects.toBe("backup_already_exists");
  expect(invoke).toHaveBeenCalledExactlyOnceWith("plugins_action", { id:"installed-plugin",action: "prepare" });
});

it("waits for the native preparation acknowledgement", async () => {
  let complete!: () => void;
  vi.mocked(invoke).mockImplementation(() => new Promise<void>((resolve) => { complete = resolve; }));
  const finished = vi.fn();
  const request = action("installed-plugin","prepare").then(finished);
  await Promise.resolve();
  expect(finished).not.toHaveBeenCalled();
  complete(); await request;
  expect(finished).toHaveBeenCalledOnce();
});
