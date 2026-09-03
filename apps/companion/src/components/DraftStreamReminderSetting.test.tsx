// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DraftStreamReminderSetting } from "./DraftStreamReminderSetting";

afterEach(() => cleanup());

describe("DraftStreamReminderSetting", () => {
  it("reflects the enabled state", () => {
    render(<DraftStreamReminderSetting enabled={true} onChange={vi.fn()} />);
    expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(true);
  });

  it("calls onChange when toggled", () => {
    const onChange = vi.fn();
    render(<DraftStreamReminderSetting enabled={false} onChange={onChange} />);
    fireEvent.click(screen.getByRole("checkbox"));
    expect(onChange).toHaveBeenCalledWith(true);
  });
});
