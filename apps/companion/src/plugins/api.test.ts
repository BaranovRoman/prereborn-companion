import { beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { dotaAction } from "./api";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
beforeEach(() => vi.clearAllMocks());

it("sends the exact preparation command and propagates native rejection", async () => {
  vi.mocked(invoke).mockRejectedValue("backup_already_exists");
  await expect(dotaAction("prepare", true)).rejects.toBe("backup_already_exists");
  expect(invoke).toHaveBeenCalledExactlyOnceWith("dota_runtime_action", { action: "prepare", confirmed: true });
});

it("waits for the native preparation acknowledgement", async () => {
  let complete!: () => void;
  vi.mocked(invoke).mockImplementation(() => new Promise<void>((resolve) => { complete = resolve; }));
  const finished = vi.fn();
  const request = dotaAction("prepare", true).then(finished);
  await Promise.resolve();
  expect(finished).not.toHaveBeenCalled();
  complete(); await request;
  expect(finished).toHaveBeenCalledOnce();
});
