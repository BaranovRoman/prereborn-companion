// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AutostartSetting } from "./AutostartSetting";

afterEach(cleanup);

describe("AutostartSetting", () => {
  it("shows the checkbox disabled while the real OS state is still loading", () => {
    render(<AutostartSetting state={{ phase: "loading" }} busy={false} onChange={vi.fn()} />);

    const checkbox = screen.getByRole("checkbox") as HTMLInputElement;
    expect(checkbox.disabled).toBe(true);
    expect(checkbox.checked).toBe(false);
  });

  it("reflects enabled=true from the real OS state, not a default", () => {
    render(<AutostartSetting state={{ phase: "ready", enabled: true }} busy={false} onChange={vi.fn()} />);

    expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(true);
  });

  it("calls onChange with the new value when toggled", () => {
    const onChange = vi.fn();
    render(<AutostartSetting state={{ phase: "ready", enabled: false }} busy={false} onChange={onChange} />);

    fireEvent.click(screen.getByRole("checkbox"));

    expect(onChange).toHaveBeenCalledWith(true);
  });

  it("disables the checkbox while a change is in flight", () => {
    render(<AutostartSetting state={{ phase: "ready", enabled: false }} busy onChange={vi.fn()} />);

    expect((screen.getByRole("checkbox") as HTMLInputElement).disabled).toBe(true);
  });

  it("shows an error message when the last change failed, without hiding the toggle", () => {
    render(
      <AutostartSetting
        state={{ phase: "error", message: "Access denied", enabled: false }}
        busy={false}
        onChange={vi.fn()}
      />
    );

    expect(screen.getByText(/Access denied/)).toBeTruthy();
    expect(screen.getByRole("checkbox")).toBeTruthy();
  });
});
