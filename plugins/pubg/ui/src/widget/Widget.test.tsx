// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { Widget, type WidgetState } from "./Widget";

const state = (patch: Partial<WidgetState> = {}): WidgetState => ({
  enabled: true, count: 3, scale: 100, backgroundOpacity: 70, showHeaders: true,
  matches: [
    { id: "1", map: "Erangel", place: 3, kills: 5, damage: 640 },
    { id: "2", map: "Miramar", place: 12, kills: 2, damage: 285 },
    { id: "3", map: "Rondo", place: 1, kills: 8, damage: 970 },
    { id: "4", map: "Taego", place: 40, kills: 0, damage: 12 },
  ],
  ...patch,
});
afterEach(cleanup);

describe("PUBG OBS widget", () => {
  it("shows map, place, kills and damage for at most `count` session matches", () => {
    render(<Widget state={state()} />);
    const rows = screen.getAllByRole("row");
    expect(rows).toHaveLength(4);
    expect(rows[0].textContent).toBe("КартаМестоУбийстваУрон");
    expect(rows[1].textContent).toBe("Erangel#35640");
    expect(rows[3].textContent).toBe("Rondo#18970");
    expect(screen.queryByText("Taego")).toBeNull();
  });
  it("hides headers and applies scale and background opacity", () => {
    render(<Widget state={state({ showHeaders: false, scale: 150, backgroundOpacity: 0 })} />);
    expect(screen.queryByText("Карта")).toBeNull();
    const table = screen.getByRole("table");
    expect(table.style.getPropertyValue("--pubg-widget-scale")).toBe("1.5");
    expect(table.style.getPropertyValue("--pubg-widget-bg")).toBe("0");
  });
  it("renders nothing when disabled or the session has no matches yet", () => {
    const { container, rerender } = render(<Widget state={state({ enabled: false })} />);
    expect(container.innerHTML).toBe("");
    rerender(<Widget state={state({ matches: [] })} />);
    expect(container.innerHTML).toBe("");
  });
});
