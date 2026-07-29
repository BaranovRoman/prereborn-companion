import { useState } from "react";
import type { StatusSnapshot } from "../types/status";

interface Props {
  status: StatusSnapshot | null;
  busy: boolean;
  onSave: (token: string) => Promise<void>;
}

// Токен никогда не приходит обратно от Rust-стороны после сохранения (см.
// save_companion_token в commands.rs) - после успешного сохранения просто
// очищаем поле, показывать тут нечего и незачем.
export function CompanionTokenForm({ status, busy, onSave }: Props) {
  const [value, setValue] = useState("");

  const handleSave = async () => {
    const trimmed = value.trim();
    if (!trimmed) return;
    await onSave(trimmed);
    setValue("");
  };

  return (
    <section className="companion-token">
      <h2>Companion token</h2>
      <p className="companion-token__hint">
        Токен генерируется на сайте: /stream → раздел «Companion».
      </p>
      <p className="companion-token__status">
        {status?.companion_token_configured
          ? "Токен настроен."
          : "Токен ещё не вставлен."}
      </p>
      <div className="companion-token__row">
        <input
          type="password"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="Вставьте companion token"
        />
        <button onClick={handleSave} disabled={busy || !value.trim()}>
          Сохранить
        </button>
      </div>
    </section>
  );
}
