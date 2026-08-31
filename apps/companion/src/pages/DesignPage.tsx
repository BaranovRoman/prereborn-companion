import { useEffect, useState } from "react";
import { Button, Checkbox, Input, Select, Slider, Tabs } from "../components/ui";
import * as api from "../services/dotaCompanionApi";
import type { MinimapCoverSettings, OverlayAnchor, OverlayLayoutDoc, OverlayWidgetLayout, QueueSettingsDoc } from "../types/status";

type DesignTab = "betweenMatches" | "draft" | "gameplay" | "postStream";

const TABS: { key: DesignTab; label: string }[] = [
  { key: "betweenMatches", label: "Между матчами" },
  { key: "draft", label: "Драфт" },
  { key: "gameplay", label: "Игра" },
  { key: "postStream", label: "Итоги" },
];

const ANCHOR_LABEL: Record<OverlayAnchor, string> = {
  "top-left": "Сверху слева",
  "top-center": "Сверху по центру",
  "top-right": "Сверху справа",
  "center-left": "По центру слева",
  center: "По центру",
  "center-right": "По центру справа",
  "bottom-left": "Снизу слева",
  "bottom-center": "Снизу по центру",
  "bottom-right": "Снизу справа",
};
const ANCHOR_OPTIONS = Object.keys(ANCHOR_LABEL) as OverlayAnchor[];

function WidgetSettings({
  title, widget, onChange,
}: {
  title: string;
  widget: OverlayWidgetLayout;
  onChange: (patch: Partial<OverlayWidgetLayout>) => void;
}) {
  return (
    <div className="design-page__widget-settings">
      <h3>{title}</h3>
      <Checkbox label="Показывать" checked={widget.visible} onChange={(event) => onChange({ visible: event.target.checked })} />
      <label className="design-page__field">
        <span>Привязка</span>
        <Select value={widget.anchor} onChange={(event) => onChange({ anchor: event.target.value as OverlayAnchor })}>
          {ANCHOR_OPTIONS.map((anchor) => (
            <option key={anchor} value={anchor}>{ANCHOR_LABEL[anchor]}</option>
          ))}
        </Select>
      </label>
      <label className="design-page__field">
        <span>Масштаб ({widget.scale.toFixed(2)}×)</span>
        <Slider min={0.5} max={2} step={0.05} value={widget.scale} onChange={(event) => onChange({ scale: Number(event.target.value) })} />
      </label>
      <div className="design-page__widget-position">
        <label className="design-page__field">
          <span>X, %</span>
          <Input
            type="number"
            min={0}
            max={100}
            value={widget.xVw}
            onChange={(event) => onChange({ xVw: Number(event.target.value) })}
          />
        </label>
        <label className="design-page__field">
          <span>Y, %</span>
          <Input
            type="number"
            min={0}
            max={100}
            value={widget.yVh}
            onChange={(event) => onChange({ yVh: Number(event.target.value) })}
          />
        </label>
      </div>
    </div>
  );
}

// WK-122 §17-19 - "Оформление" stops being a non-interactive debug preview:
// this is a real editor over the SAME OverlayLayout the web cabinet's own
// editor reads/writes (see backend::get_overlay_layout/save_overlay_layout,
// apps/api's /stream/companion/overlay-layout), with the preview using the
// exact same local renderer a real OBS Browser Source points at (see
// design-page__preview-frame's iframe src) - not a second implementation.
//
// Scope decision (documented, not silently dropped): the editor here is
// ordinary settings controls (visibility/anchor/scale/position fields via
// this app's ui/ primitives), not a mouse-drag-on-canvas WYSIWYG editor like
// apps/web's - see this slice's research doc §"Оформление" for why. Only
// the two widgets the local renderer actually visualizes (Session,
// CurrentGame - see overlay-renderer/OverlayApp.tsx) are editable here;
// cameraZone/minimapCover/recentMatches/companionStatus/draftProtection
// stay whatever they already were (read/written byte-for-byte, never
// reconstructed - see saveOverlayLayout's doc comment) since this editor
// has no UI for them yet. Между матчами/Итоги have no per-widget layout in
// the real data model at all (OverlayLayout only defines draft/gameplay
// scenes) - shown as read-only preview here, not fake-editable controls.
export function DesignPage() {
  const [tab, setTab] = useState<DesignTab>("betweenMatches");
  const [layout, setLayout] = useState<OverlayLayoutDoc | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedFlash, setSavedFlash] = useState(false);
  const [queueSettings, setQueueSettings] = useState<QueueSettingsDoc | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.getOverlayLayout()
      .then((data) => { if (!cancelled) setLayout(data); })
      .catch((cause) => { if (!cancelled) setError(String(cause)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => { api.getQueueSettings().then(setQueueSettings).catch(() => {}); }, []);

  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (event.data?.type !== "prereborn-overlay-draft-text-position") return;
      const frame = document.querySelector<HTMLIFrameElement>(".design-page__preview");
      if (event.source !== frame?.contentWindow || !Number.isFinite(event.data.xVw) || !Number.isFinite(event.data.yVh)) return;
      setLayout((current) => current ? {
        ...current,
        draftProtection: { ...current.draftProtection, text: { ...current.draftProtection.text, xVw: event.data.xVw, yVh: event.data.yVh } },
      } : current);
      setSavedFlash(false);
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, []);

  useEffect(() => {
    const frame = document.querySelector<HTMLIFrameElement>(".design-page__preview");
    frame?.contentWindow?.postMessage({ type: "prereborn-overlay-layout-preview", layout }, "*");
  }, [layout, tab]);

  const editableScene = tab === "draft" || tab === "gameplay" ? tab : null;

  const updateWidget = (widgetKey: "session" | "currentGame" | "recentMatches", patch: Partial<OverlayWidgetLayout>) => {
    if (!layout || !editableScene) return;
    setSavedFlash(false);
    const scene = layout.scenes[editableScene];
    setLayout({
      ...layout,
      scenes: {
        ...layout.scenes,
        [editableScene]: {
          ...scene,
          widgets: {
            ...scene.widgets,
            [widgetKey]: { ...scene.widgets[widgetKey], ...patch },
          },
        },
      },
    });
  };

  const updateMinimap = (patch: Partial<MinimapCoverSettings>) => {
    if (!layout || !editableScene) return;
    const scene = layout.scenes[editableScene];
    setSavedFlash(false);
    setLayout({ ...layout, scenes: { ...layout.scenes, [editableScene]: { ...scene, minimapCover: { ...scene.minimapCover, ...patch } } } });
  };

  const updateDraftText = (patch: Partial<OverlayLayoutDoc["draftProtection"]["text"]>) => {
    if (!layout) return;
    setSavedFlash(false);
    setLayout({ ...layout, draftProtection: { ...layout.draftProtection, text: { ...layout.draftProtection.text, ...patch } } });
  };

  const handleSave = async () => {
    if (!layout) return;
    setSaving(true);
    setError(null);
    try {
      const saved = await api.saveOverlayLayout(layout);
      setLayout(saved);
      if (queueSettings) setQueueSettings(await api.saveQueueSettings(queueSettings));
      setSavedFlash(true);
    } catch (cause) {
      setError(String(cause));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="design-page">
      <div className="page-heading">
        <span className="section-heading__eyebrow">Оформление</span>
        <h2>Оформление трансляции</h2>
        <p>
          Предпросмотр использует тот же локальный оверлей, что и OBS Browser Source
          (127.0.0.1:3666/overlay) — с реальными сохранёнными настройками.
        </p>
      </div>

      <Tabs items={TABS} active={tab} onChange={setTab} aria-label="Сцена оформления" />

      <div className="design-page__workspace">
        <div className="design-page__preview-frame">
          <iframe
            key={tab}
            className="design-page__preview"
            src={`http://127.0.0.1:3666/overlay?previewScene=${tab}&editor=1`}
            onLoad={(event) => event.currentTarget.contentWindow?.postMessage({ type: "prereborn-overlay-layout-preview", layout }, "*")}
            title="Предпросмотр локального оверлея"
          />
        </div>

        <aside className="design-page__inspector" aria-label="Настройки оформления">
          {loading && <p className="matches-panel__empty">Загрузка…</p>}

          {!loading && editableScene && layout && (
            <>
              <WidgetSettings
                title="Текущая игра"
                widget={layout.scenes[editableScene].widgets.currentGame}
                onChange={(patch) => updateWidget("currentGame", patch)}
              />
              <WidgetSettings
                title="История матчей"
                widget={layout.scenes[editableScene].widgets.recentMatches}
                onChange={(patch) => updateWidget("recentMatches", patch)}
              />
              {tab === "gameplay" && (
                <div className="design-page__widget-settings">
                  <h3>Защита миникарты</h3>
                  <Checkbox label="Показывать" checked={layout.scenes.gameplay.minimapCover.enabled} onChange={(event) => updateMinimap({ enabled: event.target.checked })} />
                  <label className="design-page__field"><span>Вариант</span><Select value={layout.scenes.gameplay.minimapCover.preset} onChange={(event) => updateMinimap({ preset: event.target.value as MinimapCoverSettings["preset"] })}>
                    <option value="clean">Чистая карта</option><option value="random-a">Dotabod</option><option value="random-b">Варды</option><option value="random-dense">Плотные варды</option><option value="interactive">Движущиеся варды</option>
                  </Select></label>
                  <label className="design-page__field"><span>Угол</span><Select value={layout.scenes.gameplay.minimapCover.anchor} onChange={(event) => updateMinimap({ anchor: event.target.value as MinimapCoverSettings["anchor"] })}>
                    <option value="top-left">Сверху слева</option><option value="top-right">Сверху справа</option><option value="bottom-left">Снизу слева</option><option value="bottom-right">Снизу справа</option>
                  </Select></label>
                  <label className="design-page__field"><span>Размер, px</span><Slider min={120} max={700} step={5} value={layout.scenes.gameplay.minimapCover.size} onChange={(event) => updateMinimap({ size: Number(event.target.value) })} /></label>
                  <div className="design-page__widget-position"><label className="design-page__field"><span>X, px</span><Input type="number" value={layout.scenes.gameplay.minimapCover.x} onChange={(event) => updateMinimap({ x: Number(event.target.value) })} /></label><label className="design-page__field"><span>Y, px</span><Input type="number" value={layout.scenes.gameplay.minimapCover.y} onChange={(event) => updateMinimap({ y: Number(event.target.value) })} /></label></div>
                </div>
              )}
              {tab === "draft" && (
                <div className="design-page__widget-settings">
                  <h3>Защита драфта</h3>
                  <Checkbox label="Включить защиту" checked={layout.draftProtection.mode === "cover"} onChange={(event) => setLayout({ ...layout, draftProtection: { ...layout.draftProtection, mode: event.target.checked ? "cover" : "off" } })} />
                  <Checkbox label="Показывать свой текст" checked={layout.draftProtection.text.visible} onChange={(event) => updateDraftText({ visible: event.target.checked })} />
                  <label className="design-page__field"><span>Текст</span><Input value={layout.draftProtection.text.content} onChange={(event) => updateDraftText({ content: event.target.value })} /></label>
                  <label className="design-page__field"><span>Масштаб ({layout.draftProtection.text.scale.toFixed(2)}×)</span><Slider min={0.5} max={2} step={0.05} value={layout.draftProtection.text.scale} onChange={(event) => updateDraftText({ scale: Number(event.target.value) })} /></label>
                  <p className="design-page__hint">Текст можно перетащить прямо в предпросмотре.</p>
                </div>
              )}
              <WidgetSettings
                title="Сессия"
                widget={layout.scenes[editableScene].widgets.session}
                onChange={(patch) => updateWidget("session", patch)}
              />
              <div className="design-page__actions">
                <Button variant="primary" onClick={() => void handleSave()} disabled={saving}>
                  {saving ? "Сохранение…" : "Сохранить"}
                </Button>
                {savedFlash && <span className="design-page__saved">Сохранено ✓</span>}
              </div>
            </>
          )}

          {!loading && tab === "betweenMatches" && queueSettings && (
            <>
              <div className="design-page__widget-settings"><h3>Блоки Between Matches</h3>
                {(["playerProfile", "streamProfile", "featuredMatch", "webcam", "favoriteHeroes", "recentGames", "twitchChat"] as const).map((key) => <Checkbox key={key} label={queueSettings.widgets.titles[key]} checked={queueSettings.visibility[key]} onChange={(event) => { setSavedFlash(false); setQueueSettings({ ...queueSettings, visibility: { ...queueSettings.visibility, [key]: event.target.checked } }); }} />)}
              </div>
              <div className="design-page__widget-settings"><h3>Канал и контент</h3>
                <label className="design-page__field"><span>Заголовок канала</span><Input value={queueSettings.widgets.titles.streamProfile} onChange={(event) => setQueueSettings({ ...queueSettings, widgets: { ...queueSettings.widgets, titles: { ...queueSettings.widgets.titles, streamProfile: event.target.value } } })} /></label>
                <label className="design-page__field"><span>Webcam / Live Capture URL</span><Input value={queueSettings.webcamImageUrl ?? ""} onChange={(event) => setQueueSettings({ ...queueSettings, webcamImageUrl: event.target.value || null })} /></label>
                <label className="design-page__field"><span>Последних игр ({queueSettings.widgets.recentGamesLimit})</span><Slider min={1} max={15} step={1} value={queueSettings.widgets.recentGamesLimit} onChange={(event) => setQueueSettings({ ...queueSettings, widgets: { ...queueSettings.widgets, recentGamesLimit: Number(event.target.value) } })} /></label>
                <p className="design-page__hint">Избранные герои выбираются в разделе «Герои» (до трёх). Социальные ссылки сохраняются в существующих настройках аккаунта.</p>
              </div>
              <div className="design-page__actions"><Button variant="primary" onClick={() => void handleSave()} disabled={saving}>{saving ? "Сохранение…" : "Сохранить"}</Button>{savedFlash && <span className="design-page__saved">Сохранено ✓</span>}</div>
            </>
          )}

          {!loading && tab === "postStream" && <p className="design-page__hint">Итоги автоматически используют текущую локальную сессию и завершённые матчи.</p>}

          {error && <p className="app__error">Ошибка: {error}</p>}
        </aside>
      </div>
    </div>
  );
}
