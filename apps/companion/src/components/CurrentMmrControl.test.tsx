// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CurrentMmrControl } from "./CurrentMmrControl";

const { setCurrentMmr } = vi.hoisted(() => ({ setCurrentMmr: vi.fn() }));
vi.mock("../services/dotaCompanionApi", () => ({ setCurrentMmr: (...args: unknown[]) => setCurrentMmr(...args) }));

afterEach(() => {
  cleanup();
  setCurrentMmr.mockReset();
});

describe("CurrentMmrControl", () => {
  it("shows an explicit CTA when Current MMR is unset", () => {
    render(<CurrentMmrControl currentMmr={null} sessionDelta={null} hasSession={false} />);
    expect(screen.getByRole("button", { name: "Указать MMR" })).toBeTruthy();
    expect(screen.getByText("Будет стартовым MMR следующей сессии.")).toBeTruthy();
  });

  it("allows Current MMR to be configured before a stream starts", () => {
    render(<CurrentMmrControl currentMmr={null} sessionDelta={null} hasSession={false} />);
    expect(screen.getByRole("button", { name: "Указать MMR" })).not.toHaveProperty("disabled", true);
  });

  it("sets Current MMR through the local-first command", async () => {
    setCurrentMmr.mockResolvedValue({ ratingCurrent: 5_250, sessionDelta: 0 });
    render(<CurrentMmrControl currentMmr={null} sessionDelta={null} hasSession />);
    fireEvent.click(screen.getByRole("button", { name: "Указать MMR" }));
    fireEvent.change(screen.getByLabelText("Текущий MMR"), { target: { value: "5250" } });
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
    await waitFor(() => expect(setCurrentMmr).toHaveBeenCalledWith(5_250));
    expect(await screen.findByText("5250")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Изменить" })).toBeTruthy();
  });

  it("shows configured Current MMR with a compact correction action", () => {
    render(<CurrentMmrControl currentMmr={6_125} sessionDelta={25} hasSession />);
    expect(screen.getByText("6125")).toBeTruthy();
    expect(screen.getByText("+25 за сессию")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Изменить" })).toBeTruthy();
  });

  it("nudges Current MMR up by 25 through the compact stepper", async () => {
    setCurrentMmr.mockResolvedValue({ ratingCurrent: 6_150, sessionDelta: 50 });
    render(<CurrentMmrControl currentMmr={6_125} sessionDelta={25} hasSession />);
    fireEvent.click(screen.getByRole("button", { name: "Увеличить MMR на 25" }));
    await waitFor(() => expect(setCurrentMmr).toHaveBeenCalledWith(6_150));
    expect(await screen.findByText("6150")).toBeTruthy();
  });

  it("nudges Current MMR down by 25 through the compact stepper", async () => {
    setCurrentMmr.mockResolvedValue({ ratingCurrent: 6_100, sessionDelta: 0 });
    render(<CurrentMmrControl currentMmr={6_125} sessionDelta={25} hasSession />);
    fireEvent.click(screen.getByRole("button", { name: "Уменьшить MMR на 25" }));
    await waitFor(() => expect(setCurrentMmr).toHaveBeenCalledWith(6_100));
    expect(await screen.findByText("6100")).toBeTruthy();
  });
});
