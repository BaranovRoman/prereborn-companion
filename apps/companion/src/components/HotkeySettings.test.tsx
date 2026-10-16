// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HotkeySettings, HotkeyBindRow } from "./HotkeySettings";

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

  describe("independent hotkey recorders",()=>{
    it("keeps recording and defaults separate from the TTS shortcut",()=>{
      const skip=vi.fn();const other=vi.fn().mockResolvedValue(undefined);
      render(<><HotkeySettings status={{enabled:true,shortcut:"Ctrl+Alt+F9",registered:true,lastError:null}} busy={false} onUpdate={skip}/><HotkeyBindRow enableDescription="Другое действие" bindLabel="Другая клавиша" status={{enabled:true,shortcut:"Ctrl+Alt+F12",registered:true,lastError:null}} busy={false} defaultShortcut="Ctrl+Alt+F11" onUpdate={other}/></>);
      fireEvent.click(screen.getByRole("button",{name:"Ctrl+Alt+F12"}));
      expect(screen.getByRole("button",{name:"Ctrl+Alt+F9"})).toBeTruthy();
      fireEvent.keyDown(window,{code:"F10",key:"F10"});expect(other).toHaveBeenCalledWith(true,expect.stringContaining("F10"));expect(skip).not.toHaveBeenCalled();
      fireEvent.click(screen.getAllByRole("button",{name:"Сбросить по умолчанию"})[1]);expect(other).toHaveBeenCalledWith(true,"Ctrl+Alt+F11");
    });
  });
});
