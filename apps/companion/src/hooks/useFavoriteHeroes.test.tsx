// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../services/dotaCompanionApi", () => ({
  getFavoriteHeroes: vi.fn(),
  saveFavoriteHeroes: vi.fn(),
}));

// eslint-disable-next-line import/order
import { getFavoriteHeroes, saveFavoriteHeroes } from "../services/dotaCompanionApi";
// eslint-disable-next-line import/order
import { useFavoriteHeroes } from "./useFavoriteHeroes";

const mockedGet = vi.mocked(getFavoriteHeroes);
const mockedSave = vi.mocked(saveFavoriteHeroes);

beforeEach(() => {
  mockedGet.mockReset();
  mockedSave.mockReset();
});
afterEach(() => vi.clearAllMocks());

describe("useFavoriteHeroes", () => {
  it("loads favorites on mount", async () => {
    mockedGet.mockResolvedValue([14, 74]);
    const { result } = renderHook(() => useFavoriteHeroes());
    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.heroIds).toEqual([14, 74]);
  });

  it("toggling an unfavorited hero adds it, optimistically then confirmed by the backend", async () => {
    mockedGet.mockResolvedValue([]);
    mockedSave.mockResolvedValue([14]);
    const { result } = renderHook(() => useFavoriteHeroes());
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.toggle(14);
    });

    expect(mockedSave).toHaveBeenCalledWith([14]);
    expect(result.current.heroIds).toEqual([14]);
  });

  it("toggling an already-favorited hero removes it", async () => {
    mockedGet.mockResolvedValue([14, 74]);
    mockedSave.mockResolvedValue([74]);
    const { result } = renderHook(() => useFavoriteHeroes());
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.toggle(14);
    });

    expect(mockedSave).toHaveBeenCalledWith([74]);
    expect(result.current.heroIds).toEqual([74]);
  });

  it("refuses to add a 4th favorite without calling the backend", async () => {
    mockedGet.mockResolvedValue([1, 2, 3]);
    const { result } = renderHook(() => useFavoriteHeroes());
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.toggle(4);
    });

    expect(mockedSave).not.toHaveBeenCalled();
    expect(result.current.heroIds).toEqual([1, 2, 3]);
    expect(result.current.error).toMatch(/3/);
  });

  it("rolls back the optimistic update if the backend save fails", async () => {
    mockedGet.mockResolvedValue([]);
    mockedSave.mockRejectedValue(new Error("network down"));
    const { result } = renderHook(() => useFavoriteHeroes());
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.toggle(14);
    });

    expect(result.current.heroIds).toEqual([]);
    expect(result.current.error).toContain("network down");
  });
});
