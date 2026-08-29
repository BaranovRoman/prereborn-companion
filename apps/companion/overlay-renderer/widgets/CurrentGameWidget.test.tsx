// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { CurrentGameWidget } from "./CurrentGameWidget";

afterEach(() => cleanup());

describe("CurrentGameWidget", () => {
  it("renders nothing when there is no active hero", () => {
    const { container } = render(<CurrentGameWidget game={null} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing when heroId is null", () => {
    const { container } = render(<CurrentGameWidget game={{ heroId: null, kills: null, deaths: null, assists: null }} />);
    expect(container.firstChild).toBeNull();
  });

  it("resolves hero name via the shared heroCatalog (no second hero-id mapping)", () => {
    render(<CurrentGameWidget game={{ heroId: 14, kills: null, deaths: null, assists: null }} />);
    expect(screen.getByText("Pudge")).toBeTruthy();
  });

  it("falls back to a numeric label for an unmapped hero id", () => {
    render(<CurrentGameWidget game={{ heroId: 999999, kills: null, deaths: null, assists: null }} />);
    expect(screen.getByText("Герой #999999")).toBeTruthy();
  });

  it("shows KDA when present", () => {
    render(<CurrentGameWidget game={{ heroId: 14, kills: 8, deaths: 2, assists: 11 }} />);
    expect(screen.getByText("8 / 2 / 11")).toBeTruthy();
  });
});
