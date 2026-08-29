import { useEffect, useState } from "react";
import { Button, Checkbox, Input, Select, Slider, Tabs } from "../components/ui";
import * as api from "../services/dotaCompanionApi";
import type { OverlayAnchor, OverlayLayoutDoc, OverlayWidgetLayout } from "../types/status";

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

  useEffect(() => {
    let cancelled = false;
    api.getOverlayLayout()
      .then((data) => { if (!cancelled) setLayout(data); })
      .catch((cause) => { if (!cancelled) setError(String(cause)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const editableScene = tab === "draft" || tab === "gameplay" ? tab : null;

  const updateWidget = (widgetKey: "session" | "currentGame", patch: Partial<OverlayWidgetLayout>) => {
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

  const handleSave = async () => {
    if (!layout) return;
    setSaving(true);
    setError(null);
    try {
      const saved = await api.saveOverlayLayout(layout);
      setLayout(saved);
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
            src={`http://127.0.0.1:3666/overlay?previewScene=${tab}`}
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

          {!loading && !editableScene && (
            <p className="design-page__hint">
              У сцены «{TABS.find((item) => item.key === tab)?.label}» нет отдельных виджетов
              положения — показывается фиксированная сводка сессии по центру экрана.
            </p>
          )}

          {error && <p className="app__error">Ошибка: {error}</p>}
        </aside>
      </div>
    </div>
  );
}
