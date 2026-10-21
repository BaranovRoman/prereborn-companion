import { Button, Checkbox, Radio, Select, Slider } from "../components/ui";
import type { ChatOverlayControl } from "./useChatOverlay";

// WK-179 - controls for the "chat over the game" overlay window, shown in the
// Twitch chat screen's sidebar. Click-through makes the overlay ignore the
// mouse entirely, so it can only be switched back from here.
export function ChatOverlayControls({ overlay }: { overlay: ChatOverlayControl }) {
  const { status, settings, error, busy, updateSetting, setOpen, setClickThrough } = overlay;
  return <div className="chat-overlay-controls">
    <h3>Чат поверх игры</h3>
    <p>Отдельное прозрачное окно поверх игры. Игра должна быть в режиме «Оконный (без рамки)».</p>
    <Button onClick={() => setOpen(!status.open)} disabled={busy}>{status.open ? "Скрыть оверлей" : "Показать оверлей"}</Button>
    <Checkbox label="Пропускать клики (окно не мешает игре)" checked={status.clickThrough} disabled={busy}
      onChange={(event) => setClickThrough(event.target.checked)} />
    {!status.clickThrough && status.open && <p>Перетащите окно за верхнюю полосу, размер — за правый нижний угол. Затем включите пропуск кликов.</p>}
    <div className="chat-overlay-controls__styles">
      <Radio name="chatOverlayStyle" label="В стиле WoW-чата" checked={settings.style === "wow"} onChange={() => updateSetting("style", "wow")} />
      <Radio name="chatOverlayStyle" label="Обычный" checked={settings.style === "plain"} onChange={() => updateSetting("style", "plain")} />
    </div>
    <label>Фон: {settings.backgroundOpacity}%
      <Slider min={0} max={100} value={settings.backgroundOpacity} onChange={(event) => updateSetting("backgroundOpacity", Number(event.target.value))} />
    </label>
    <label>Размер текста: {settings.fontSize}px
      <Slider min={11} max={32} value={settings.fontSize} onChange={(event) => updateSetting("fontSize", Number(event.target.value))} />
    </label>
    <label>Сообщений на экране
      <Select value={settings.maxMessages} onChange={(event) => updateSetting("maxMessages", Number(event.target.value))}>
        {[5, 10, 20, 30, 50].map((count) => <option key={count} value={count}>{count}</option>)}
      </Select>
    </label>
    <Checkbox label="Скрывать команды (!…)" checked={settings.hideCommands} onChange={(event) => updateSetting("hideCommands", event.target.checked)} />
    <Checkbox label="Эмоции 7TV / BTTV / FFZ" checked={settings.showEmotes} onChange={(event) => updateSetting("showEmotes", event.target.checked)} />
    <Checkbox label="Значки стримера, модераторов, VIP и подписчиков" checked={settings.showBadges} onChange={(event) => updateSetting("showBadges", event.target.checked)} />
    {error && <p className="app__error">{error}</p>}
  </div>;
}
