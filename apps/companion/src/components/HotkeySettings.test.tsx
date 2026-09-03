// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HotkeySettings } from "./HotkeySettings";

afterEach(cleanup);

// Companion UI 2.0 follow-up - "перенеси существующие hotkey controls в
// Настройки": this is the same recording/reset/enable behavior that used
// to live inline in TwitchChatPage (WK-93), moved verbatim into its own
// component. These tests pin that the moved behavior still works exactly
// as it did there.
describe("HotkeySettings", () => {
  it("shows the default shortcut when no status is loaded yet", () => {
    render(<HotkeySettings status={null} busy={false} onUpdate={vi.fn()} />);
    expect(screen.getByText(/CommandOrControl\+Alt\+F10/)).toBeTruthy();
    expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(false);
  });

  it("reflects the current enabled/shortcut status", () => {
    render(
      <HotkeySettings
        status={{ enabled: true, shortcut: "Ctrl+Alt+F9", registered: true, lastError: null }}
        busy={false}
        onUpdate={vi.fn()}
      />
    );
    expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText(/Ctrl\+Alt\+F9/)).toBeTruthy();
  });

  it("flags an enabled-but-unregistered shortcut", () => {
    render(
      <HotkeySettings
        status={{ enabled: true, shortcut: "Ctrl+Alt+F9", registered: false, lastError: null }}
        busy={false}
        onUpdate={vi.fn()}
      />
    );
    expect(screen.getByText(/не удалось зарегистрировать/i)).toBeTruthy();
  });

  it("toggling the checkbox calls onUpdate with the current shortcut", () => {
    const onUpdate = vi.fn().mockResolvedValue(undefined);
    render(
      <HotkeySettings
        status={{ enabled: false, shortcut: "Ctrl+Alt+F9", registered: false, lastError: null }}
        busy={false}
        onUpdate={onUpdate}
      />
    );
    fireEvent.click(screen.getByRole("checkbox"));
    expect(onUpdate).toHaveBeenCalledWith(true, "Ctrl+Alt+F9");
  });

  it("reset-to-default calls onUpdate with the default shortcut", () => {
    const onUpdate = vi.fn().mockResolvedValue(undefined);
    render(
      <HotkeySettings
        status={{ enabled: true, shortcut: "Ctrl+Alt+F9", registered: true, lastError: null }}
        busy={false}
        onUpdate={onUpdate}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Сбросить по умолчанию" }));
    expect(onUpdate).toHaveBeenCalledWith(true, "CommandOrControl+Alt+F10");
  });

  it("recording a new shortcut captures the next keydown and calls onUpdate", () => {
    const onUpdate = vi.fn().mockResolvedValue(undefined);
    render(
      <HotkeySettings
        status={{ enabled: true, shortcut: "Ctrl+Alt+F9", registered: true, lastError: null }}
        busy={false}
        onUpdate={onUpdate}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Ctrl+Alt+F9" }));
    expect(screen.getByRole("button", { name: /Нажмите клавиши/ })).toBeTruthy();

    fireEvent.keyDown(window, { code: "F11", key: "F11" });

    expect(onUpdate).toHaveBeenCalledWith(true, expect.stringContaining("F11"));
  });

  it("Escape cancels recording without calling onUpdate", () => {
    const onUpdate = vi.fn().mockResolvedValue(undefined);
    render(
      <HotkeySettings
        status={{ enabled: true, shortcut: "Ctrl+Alt+F9", registered: true, lastError: null }}
        busy={false}
        onUpdate={onUpdate}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Ctrl+Alt+F9" }));
    fireEvent.keyDown(window, { code: "Escape", key: "Escape" });

    expect(onUpdate).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Ctrl+Alt+F9" })).toBeTruthy();
  });

  it("disables controls while busy", () => {
    render(
      <HotkeySettings
        status={{ enabled: true, shortcut: "Ctrl+Alt+F9", registered: true, lastError: null }}
        busy
        onUpdate={vi.fn()}
      />
    );
    expect((screen.getByRole("checkbox") as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Ctrl+Alt+F9" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows a lastError from status even without a local recording error", () => {
    render(
      <HotkeySettings
        status={{ enabled: true, shortcut: "Ctrl+Alt+F9", registered: false, lastError: "Не удалось зарегистрировать хоткей" }}
        busy={false}
        onUpdate={vi.fn()}
      />
    );
    expect(screen.getByText(/Не удалось зарегистрировать хоткей/)).toBeTruthy();
  });

  // WK-135 - overlay show/hide hotkey, a second independent row reusing the
  // exact same HotkeyBindRow. Pins that the two rows keep fully independent
  // recording/error state - recording one must never affect the other.
  describe("with the overlay row", () => {
    it("renders both rows with their own shortcuts", () => {
      render(
        <HotkeySettings
          status={{ enabled: true, shortcut: "Ctrl+Alt+F9", registered: true, lastError: null }}
          busy={false}
          onUpdate={vi.fn()}
          overlay={{
            status: { enabled: true, shortcut: "Ctrl+Alt+F11", registered: true, lastError: null },
            busy: false,
            onUpdate: vi.fn(),
          }}
        />
      );
      expect(screen.getByRole("button", { name: "Ctrl+Alt+F9" })).toBeTruthy();
      expect(screen.getByRole("button", { name: "Ctrl+Alt+F11" })).toBeTruthy();
      expect(screen.getAllByRole("checkbox")).toHaveLength(2);
    });

    it("recording the overlay row's shortcut does not put the skip-TTS row into recording state", () => {
      const skipUpdate = vi.fn().mockResolvedValue(undefined);
      const overlayUpdate = vi.fn().mockResolvedValue(undefined);
      render(
        <HotkeySettings
          status={{ enabled: true, shortcut: "Ctrl+Alt+F9", registered: true, lastError: null }}
          busy={false}
          onUpdate={skipUpdate}
          overlay={{
            status: { enabled: true, shortcut: "Ctrl+Alt+F11", registered: true, lastError: null },
            busy: false,
            onUpdate: overlayUpdate,
          }}
        />
      );
      fireEvent.click(screen.getByRole("button", { name: "Ctrl+Alt+F11" }));
      // Only the overlay row entered recording mode.
      expect(screen.getByRole("button", { name: /Нажмите клавиши/ })).toBeTruthy();
      expect(screen.getByRole("button", { name: "Ctrl+Alt+F9" })).toBeTruthy();

      fireEvent.keyDown(window, { code: "F12", key: "F12" });
      expect(overlayUpdate).toHaveBeenCalledWith(true, expect.stringContaining("F12"));
      expect(skipUpdate).not.toHaveBeenCalled();
    });

    it("resetting the overlay row uses its own default shortcut", () => {
      const overlayUpdate = vi.fn().mockResolvedValue(undefined);
      render(
        <HotkeySettings
          status={{ enabled: true, shortcut: "Ctrl+Alt+F9", registered: true, lastError: null }}
          busy={false}
          onUpdate={vi.fn()}
          overlay={{
            status: { enabled: true, shortcut: "Ctrl+Alt+F12", registered: true, lastError: null },
            busy: false,
            onUpdate: overlayUpdate,
          }}
        />
      );
      const resetButtons = screen.getAllByRole("button", { name: "Сбросить по умолчанию" });
      fireEvent.click(resetButtons[1]);
      expect(overlayUpdate).toHaveBeenCalledWith(true, "CommandOrControl+Alt+F11");
    });
  });
});
