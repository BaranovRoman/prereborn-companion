// @vitest-environment jsdom
import { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useModalBehavior } from "./useModalBehavior";

// WK-128 P0 regression - production bug: typing into any input inside a
// modal built on this hook (AccountForm's login email/password, inside
// SettingsModal) repeatedly lost focus mid-word. Root cause: the hook's
// focus-management effect used to depend on `onClose`, and AppShell (like
// many real callers) passes an inline `onClose={() => setX(false)}` - a new
// function identity on every parent render, which AppShell produces
// continuously from its own unrelated status/GSI polling. Each "new"
// identity re-ran the effect, which called `containerRef.current?.focus()`
// every time, stealing focus off whatever input was active.
//
// This harness reproduces the exact shape of the bug: an outer component
// re-renders on an external tick (standing in for AppShell's polling) and
// passes a BRAND NEW `onClose` closure into the modal every single time -
// the worst case, not a best-effort stable one - proving the fix holds
// regardless of caller discipline.
function Harness() {
  const [tick, setTick] = useState(0);
  const [email, setEmail] = useState("");
  const containerRef = useModalBehavior(true, () => setTick((t) => t + 1));
  return (
    <div>
      <button onClick={() => setTick((t) => t + 1)}>force unrelated rerender</button>
      <div ref={containerRef as React.RefObject<HTMLDivElement>} tabIndex={-1} data-testid="modal-container">
        <input aria-label="Email" value={email} onChange={(event) => setEmail(event.target.value)} />
      </div>
      <p data-testid="tick">{tick}</p>
    </div>
  );
}

afterEach(() => cleanup());

describe("useModalBehavior", () => {
  it("moves focus into the container once when the modal opens", () => {
    render(<Harness />);
    expect(document.activeElement).toBe(screen.getByTestId("modal-container"));
  });

  // The actual regression: focus must stay on the input across repeated
  // parent re-renders (each supplying a fresh onClose closure) while the
  // user types - not get yanked back onto the modal container mid-word.
  it("typing into a child input survives repeated parent rerenders with a fresh onClose identity each time", () => {
    render(<Harness />);
    const input = screen.getByLabelText("Email");
    const rerenderButton = screen.getByRole("button", { name: "force unrelated rerender" });

    input.focus();
    expect(document.activeElement).toBe(input);

    for (const char of "user@example.com") {
      fireEvent.change(input, { target: { value: (input as HTMLInputElement).value + char } });
      // Simulates AppShell's own polling-driven rerenders happening between
      // keystrokes, in the real bug's exact shape (parent rerenders with a
      // NEW onClose closure) - not merely a second render of the same tree.
      fireEvent.click(rerenderButton);
      expect(document.activeElement).toBe(input);
    }

    expect((input as HTMLInputElement).value).toBe("user@example.com");
  });
});
