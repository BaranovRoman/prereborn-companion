// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useUpdater } from "./useUpdater";
vi.mock("../core/api", () => ({ checkCompanionUpdate: vi.fn() }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: vi.fn() }));
import { checkCompanionUpdate } from "../core/api";
const checked = vi.mocked(checkCompanionUpdate);
afterEach(cleanup);
beforeEach(() => vi.clearAllMocks());
function download() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  const downloadAndInstall = vi.fn((callback) => {
    callback({ event: "Finished" });
    return promise;
  });
  checked.mockResolvedValue({ version: "0.5.91", body: null, downloadAndInstall } as unknown as NonNullable<Awaited<ReturnType<typeof checkCompanionUpdate>>>);
  return { resolve, reject, downloadAndInstall };
}
it("does not expose ready before signature verification and install resolve", async () => {
  const pending = download();const { result } = renderHook(useUpdater);
  await act(() => result.current.checkForUpdate());
  let installing!: Promise<void>;
  act(() => { installing = result.current.installUpdate(); });
  expect(result.current.state.phase).toBe("downloading");
  await act(async () => { pending.resolve(); await installing; });
  expect(result.current.state).toEqual({ phase: "ready", version: "0.5.91" });
});
it("signature/install failure remains an error even after Finished", async () => {
  const pending = download();const { result } = renderHook(useUpdater);
  await act(() => result.current.checkForUpdate());
  let installing!: Promise<void>;act(() => { installing = result.current.installUpdate(); });
  expect(result.current.state.phase).toBe("downloading");
  await act(async () => { pending.reject(new Error("invalid signature")); await installing; });
  expect(result.current.state).toEqual({ phase: "error", message: "Error: invalid signature" });
});
it("a failed new check cannot install stale cached metadata", async () => {
  const pending = download();const { result } = renderHook(useUpdater);
  await act(() => result.current.checkForUpdate());
  checked.mockRejectedValueOnce(new Error("offline"));
  await act(() => result.current.checkForUpdate());
  await act(() => result.current.installUpdate());
  expect(pending.downloadAndInstall).not.toHaveBeenCalled();
});
