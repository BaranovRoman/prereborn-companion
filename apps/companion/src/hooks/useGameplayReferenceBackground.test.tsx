// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../services/dotaCompanionApi", () => ({
  getGameplayReference: vi.fn().mockResolvedValue("http://127.0.0.1:3666/overlay/assets/gameplay-reference"),
  chooseGameplayReference: vi.fn(),
  removeGameplayReference: vi.fn(),
}));

import { useGameplayReferenceBackground } from "./useGameplayReferenceBackground";

beforeEach(() => localStorage.clear());
afterEach(() => cleanup());

describe("useGameplayReferenceBackground", () => {
  it("restores the persisted local image and editor opacity", async () => {
    localStorage.setItem("gameplay-reference-opacity", "0.4");
    const { result } = renderHook(() => useGameplayReferenceBackground());
    await waitFor(() => expect(result.current.imageUrl).toContain("gameplay-reference"));
    expect(result.current.opacity).toBe(0.4);
    act(() => result.current.setOpacity(0.75));
    expect(localStorage.getItem("gameplay-reference-opacity")).toBe("0.75");
  });
});
