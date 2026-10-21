// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PronunciationDictionary } from "./PronunciationDictionary";
import { DEFAULT_CHAT_SETTINGS, type ChatSettings } from "../../chat/chat-model";
import type { TwitchChatSession } from "../../chat/useTwitchChatSession";
import type { TwitchChatMessage } from "../../core/api";

const chatter = (author: string, authorLogin: string, authorId: string): TwitchChatMessage =>
  ({ id: `${authorId}-m`, author, authorLogin, authorId, color: null, text: "привет", badges: [], messageType: "text", receivedAt: "" });

// Stateful stand-in for the real session: updateSetting really updates.
function Harness({ initial, onChange, previewSpeech, messages = [], engine = "silero" }: {
  initial?: Partial<ChatSettings>; onChange?: (s: ChatSettings) => void; previewSpeech?: (t: string) => void;
  messages?: TwitchChatMessage[]; engine?: ChatSettings["ttsEngine"];
}) {
  const [settings, setSettings] = useState<ChatSettings>({ ...DEFAULT_CHAT_SETTINGS, ttsEnabled: true, ttsEngine: engine, ...initial });
  const session = {
    status: { messages } as unknown as TwitchChatSession["status"],
    settings,
    sileroStatus: { state: "ready", resourcesReady: true, lastError: null },
    previewBusy: false,
    previewError: null,
    previewSpeech: previewSpeech ?? vi.fn(),
    updateSetting: (key: keyof ChatSettings, value: unknown) => setSettings((current) => { const next = { ...current, [key]: value }; onChange?.(next); return next; }),
  } as unknown as TwitchChatSession;
  return <PronunciationDictionary session={session} />;
}

const addRule = (source: string, spoken: string) => {
  fireEvent.change(screen.getByLabelText("Исходный текст"), { target: { value: source } });
  fireEvent.change(screen.getByLabelText("Произносить как"), { target: { value: spoken } });
  fireEvent.click(screen.getByRole("button", { name: "Добавить правило" }));
};
const rules = () => within(screen.getByRole("list", { name: "Правила произношения" })).getAllByRole("listitem");

afterEach(() => cleanup());

describe("PronunciationDictionary", () => {
  it("adds, edits, toggles and deletes rules through the settings", () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    expect(screen.getByText("Своих правил пока нет.")).toBeTruthy();
    addRule("имба", "и+мба");
    expect(rules()).toHaveLength(1);
    expect(onChange.mock.lastCall![0].pronunciationRules[0]).toMatchObject({ source: "имба", spoken: "и+мба", enabled: true, scope: { kind: "global" } });

    fireEvent.click(screen.getByRole("button", { name: "Изменить" }));
    expect((screen.getByLabelText("Исходный текст") as HTMLInputElement).value).toBe("имба");
    fireEvent.change(screen.getByLabelText("Произносить как"), { target: { value: "имбища" } });
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
    expect(rules()).toHaveLength(1);
    expect(within(rules()[0]).getByText("имбища")).toBeTruthy();

    fireEvent.click(screen.getByRole("switch", { name: "Правило «имба» включено" }));
    expect(onChange.mock.lastCall![0].pronunciationRules[0].enabled).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Удалить правило «имба»" }));
    expect(onChange.mock.lastCall![0].pronunciationRules).toEqual([]);
  });

  it("refuses a duplicate in the same scope and explains why", () => {
    render(<Harness />);
    addRule("кек", "кэк");
    addRule("КЕК", "кеек");
    expect(screen.getByText("Общее правило для «КЕК» уже есть.")).toBeTruthy();
    expect(rules()).toHaveLength(1);
    addRule("", "x");
    expect(screen.getByText("Укажите исходный текст.")).toBeTruthy();
  });

  it("binds a personal rule to the Twitch id of a recent chatter", () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} messages={[chatter("Roma", "roma", "4242")]} />);
    fireEvent.change(screen.getByLabelText("Где действует"), { target: { value: "user" } });
    fireEvent.change(screen.getByLabelText("Ник зрителя"), { target: { value: "@Roma" } });
    expect(screen.getByText("Привязано к Twitch ID")).toBeTruthy();
    addRule("лол", "лолик");
    expect(onChange.mock.lastCall![0].pronunciationRules[0].scope).toEqual({ kind: "user", login: "roma", userId: "4242" });
    expect(within(rules()[0]).getByText("@roma")).toBeTruthy();
  });

  it("keeps a personal rule login-only when the viewer isn't in recent chat", () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    fireEvent.change(screen.getByLabelText("Где действует"), { target: { value: "user" } });
    fireEvent.change(screen.getByLabelText("Ник зрителя"), { target: { value: "someone" } });
    addRule("лол", "лолик");
    expect(onChange.mock.lastCall![0].pronunciationRules[0].scope).toEqual({ kind: "user", login: "someone", userId: null });
  });

  it("previews exactly what will be spoken and plays it through the session", () => {
    const previewSpeech = vi.fn();
    render(<Harness previewSpeech={previewSpeech} messages={[chatter("Roma", "roma", "1")]} />);
    expect(screen.getByText("хэзэ, аха-ха-ха плюс двадцать пять")).toBeTruthy();
    addRule("кек", "кэк");
    fireEvent.change(screen.getByLabelText("Где действует"), { target: { value: "user" } });
    fireEvent.change(screen.getByLabelText("Ник зрителя"), { target: { value: "roma" } });
    addRule("кек", "кекус");
    fireEvent.change(screen.getByLabelText("Проверить фразу"), { target: { value: "кек тб" } });
    expect(screen.getByText("кэк тэбэ")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("От зрителя"), { target: { value: "roma" } });
    expect(screen.getByText("кекус тэбэ")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Прослушать" }));
    expect(previewSpeech).toHaveBeenCalledWith("кекус тэбэ");
  });
});
