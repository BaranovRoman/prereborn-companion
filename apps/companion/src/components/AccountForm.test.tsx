// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../services/dotaCompanionApi", () => ({
  getAccountStatus: vi.fn(),
  accountLogin: vi.fn(),
  accountLogout: vi.fn(),
}));

// eslint-disable-next-line import/order
import { accountLogin, accountLogout, getAccountStatus } from "../services/dotaCompanionApi";
// eslint-disable-next-line import/order
import { AccountForm } from "./AccountForm";

const mockedStatus = vi.mocked(getAccountStatus);
const mockedLogin = vi.mocked(accountLogin);
const mockedLogout = vi.mocked(accountLogout);

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe("AccountForm", () => {
  it("shows the login form when disconnected", async () => {
    mockedStatus.mockResolvedValue({ connected: false, method: "none", email: null });
    render(<AccountForm />);
    await waitFor(() => expect(screen.getByPlaceholderText("Email")).toBeTruthy());
    expect(screen.getByPlaceholderText("Пароль")).toBeTruthy();
    expect(screen.queryByText("Подключено")).toBeNull();
  });

  it("shows the connected view with the account's email and no password field, for a session login", async () => {
    mockedStatus.mockResolvedValue({ connected: true, method: "session", email: "roma@example.com" });
    render(<AccountForm />);
    await waitFor(() => expect(screen.getByText("roma@example.com")).toBeTruthy());
    expect(screen.getByRole("button", { name: "Выйти" })).toBeTruthy();
    expect(screen.queryByPlaceholderText("Пароль")).toBeNull();
  });

  it("shows a plain connected state (no email) for a legacy-token install, offering to switch to account login", async () => {
    mockedStatus.mockResolvedValue({ connected: true, method: "legacy_token", email: null });
    render(<AccountForm />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Войти через аккаунт" })).toBeTruthy());
    expect(screen.getByRole("button", { name: "Выйти" })).toBeTruthy();
  });

  it("logs in with the entered email/password and switches to the connected view", async () => {
    mockedStatus.mockResolvedValue({ connected: false, method: "none", email: null });
    mockedLogin.mockResolvedValue({ connected: true, method: "session", email: "roma@example.com" });
    render(<AccountForm />);
    await waitFor(() => expect(screen.getByPlaceholderText("Email")).toBeTruthy());

    fireEvent.change(screen.getByPlaceholderText("Email"), { target: { value: "roma@example.com" } });
    fireEvent.change(screen.getByPlaceholderText("Пароль"), { target: { value: "correct-horse" } });
    fireEvent.click(screen.getByRole("button", { name: "Войти" }));

    await waitFor(() => expect(screen.getByText("roma@example.com")).toBeTruthy());
    expect(mockedLogin).toHaveBeenCalledWith("roma@example.com", "correct-horse");
    // The password never lingers in the DOM/state after a successful login.
    expect(screen.queryByDisplayValue("correct-horse")).toBeNull();
  });

  it("shows the login error without clearing what the user typed", async () => {
    mockedStatus.mockResolvedValue({ connected: false, method: "none", email: null });
    mockedLogin.mockRejectedValue(new Error("Неверный email или пароль."));
    render(<AccountForm />);
    await waitFor(() => expect(screen.getByPlaceholderText("Email")).toBeTruthy());

    fireEvent.change(screen.getByPlaceholderText("Email"), { target: { value: "roma@example.com" } });
    fireEvent.change(screen.getByPlaceholderText("Пароль"), { target: { value: "wrong" } });
    fireEvent.click(screen.getByRole("button", { name: "Войти" }));

    await waitFor(() => expect(screen.getByText(/Неверный email или пароль/)).toBeTruthy());
    expect((screen.getByPlaceholderText("Email") as HTMLInputElement).value).toBe("roma@example.com");
  });

  it("logs out and returns to the login form", async () => {
    mockedStatus.mockResolvedValue({ connected: true, method: "session", email: "roma@example.com" });
    mockedLogout.mockResolvedValue({ connected: false, method: "none", email: null });
    render(<AccountForm />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Выйти" })).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Выйти" }));

    await waitFor(() => expect(screen.getByPlaceholderText("Email")).toBeTruthy());
    expect(mockedLogout).toHaveBeenCalled();
  });

  it("never renders the raw token/refresh-token anywhere - AccountStatus never carries one", async () => {
    mockedStatus.mockResolvedValue({ connected: true, method: "session", email: "roma@example.com" });
    const { container } = render(<AccountForm />);
    await waitFor(() => expect(screen.getByText("roma@example.com")).toBeTruthy());
    // A companion token/JWT is long and has no spaces - a crude but honest
    // guard that nothing resembling one ever ends up in the rendered DOM.
    expect(container.textContent).not.toMatch(/[A-Za-z0-9_-]{40,}/);
  });

  it("compact mode omits the section heading (used embedded in HomePage's checklist)", async () => {
    mockedStatus.mockResolvedValue({ connected: false, method: "none", email: null });
    render(<AccountForm compact />);
    await waitFor(() => expect(screen.getByPlaceholderText("Email")).toBeTruthy());
    expect(screen.queryByRole("heading", { name: "Аккаунт" })).toBeNull();
  });
});
