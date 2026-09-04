import { useEffect, useState } from "react";
import { Button, Checkbox, Input, Select, Slider, Tabs } from "../components/ui";
import * as api from "../services/dotaCompanionApi";
import type { MinimapCoverSettings, OverlayAnchor, OverlayLayoutDoc, OverlayWidgetLayout, QueueSettingsDoc } from "../types/status";
import { useGameplayReferenceBackground } from "../hooks/useGameplayReferenceBackground";
import { useLocalOverlayPreviewReady } from "../hooks/useLocalOverlayPreviewReady";

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
const MINIMAP_SIZE = { normal: 282, large: 360 } as const;

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
// Session/RecentMatches - see overlay-renderer/OverlayApp.tsx) are editable here;
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
  const [currentMmr, setCurrentMmr] = useState<number | null>(null);
  const referenceBackground = useGameplayReferenceBackground();
  const preview = useLocalOverlayPreviewReady();

  useEffect(() => {
    let cancelled = false;
    api.getOverlayLayout()
      .then((data) => { if (!cancelled) setLayout(data); })
      .catch((cause) => { if (!cancelled) setError(String(cause)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => { api.getQueueSettings().then(setQueueSettings).catch(() => {}); }, []);
  useEffect(() => { api.getLocalSessionSummary().then((summary) => setCurrentMmr(summary.ratingCurrent)).catch(() => {}); }, []);

  useEffect(() => {
    const receive = (event: MessageEvent) => {
      const frame = document.querySelector<HTMLIFrameElement>(".design-page__preview");
      if (event.source !== frame?.contentWindow) return;
      if (event.data?.type === "prereborn-overlay-widget-change") {
        const { scene, widget, patch } = event.data;
        if ((scene !== "draft" && scene !== "gameplay") || !["session", "recentMatches"].includes(widget) || !patch) return;
        const sceneKey = scene as "draft" | "gameplay";
        const widgetKey = widget as "session" | "recentMatches";
        const widgetPatch = patch as Partial<OverlayWidgetLayout>;
        setLayout((current) => {
          if (!current) return current;
          const currentScene = current.scenes[sceneKey];
          return { ...current, scenes: { ...current.scenes, [sceneKey]: { ...currentScene, widgets: { ...currentScene.widgets, [widgetKey]: { ...currentScene.widgets[widgetKey], ...widgetPatch } } } } };
        });
        setSavedFlash(false);
        return;
      }
      if (event.data?.type === "prereborn-overlay-draft-text-change" && event.data.patch) {
        setLayout((current) => current ? { ...current, draftProtection: { ...current.draftProtection, text: { ...current.draftProtection.text, ...event.data.patch } } } : current);
        setSavedFlash(false);
        return;
      }
      if (event.data?.type === "prereborn-overlay-minimap-change" && event.data.patch) {
        setLayout((current) => current ? { ...current, scenes: { ...current.scenes, gameplay: { ...current.scenes.gameplay, minimapCover: { ...current.scenes.gameplay.minimapCover, ...event.data.patch } } } } : current);
        setSavedFlash(false);
        return;
      }
      if (event.data?.type === "prereborn-overlay-camera-change" && event.data.patch && event.data.scene === "gameplay") {
        setLayout((current) => current ? { ...current, scenes: { ...current.scenes, gameplay: { ...current.scenes.gameplay, cameraZone: { ...current.scenes.gameplay.cameraZone, ...event.data.patch } } } } : current);
        setSavedFlash(false);
        return;
      }
      if (event.data?.type !== "prereborn-overlay-draft-text-position" || !Number.isFinite(event.data.xVw) || !Number.isFinite(event.data.yVh)) return;
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
    frame?.contentWindow?.postMessage({ type: "prereborn-overlay-layout-preview", layout, queueSettings, referenceBackground: tab === "gameplay" && referenceBackground.imageUrl ? { url: referenceBackground.imageUrl, opacity: referenceBackground.opacity } : null }, "*");
  }, [layout, queueSettings, tab, referenceBackground.imageUrl, referenceBackground.opacity]);

  const editableScene = tab === "gameplay" ? tab : null;

  const updateWidget = (widgetKey: "session" | "recentMatches", patch: Partial<OverlayWidgetLayout>) => {
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

  const chooseWebcamFallback = async () => {
    if (!queueSettings) return;
    try {
      const webcamImageUrl = await api.chooseQueueWebcamFallback();
      setQueueSettings({ ...queueSettings, webcamImageUrl });
      setSavedFlash(false);
    } catch (cause) { if (!String(cause).includes("отменён")) setError(String(cause)); }
  };

  const removeWebcamFallback = async () => {
    if (!queueSettings) return;
    await api.removeQueueWebcamFallback();
    setQueueSettings({ ...queueSettings, webcamImageUrl: null });
    setSavedFlash(false);
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
          {preview.ready ? (
            <iframe
              key={tab}
              className="design-page__preview"
              src={`http://127.0.0.1:3666/overlay?previewScene=${tab}&editor=1`}
              onLoad={(event) => event.currentTarget.contentWindow?.postMessage({ type: "prereborn-overlay-layout-preview", layout, queueSettings, referenceBackground: tab === "gameplay" && referenceBackground.imageUrl ? { url: referenceBackground.imageUrl, opacity: referenceBackground.opacity } : null }, "*")}
              title="Предпросмотр локального оверлея"
            />
          ) : (
            <div className="design-page__preview-placeholder">
              {preview.error ? (
                <>
                  <p className="app__error">{preview.error}</p>
                  <Button onClick={preview.retry}>Повторить</Button>
                </>
              ) : (
                <p className="matches-panel__empty">Ожидаем локальный оверлей…</p>
              )}
            </div>
          )}
        </div>

        <aside className="design-page__inspector" aria-label="Настройки оформления">
          {loading && <p className="matches-panel__empty">Загрузка…</p>}

          {!loading && tab === "gameplay" && layout && (
            <>
              <div className="design-page__widget-settings">
                <h3>Скриншот Dota</h3>
                {referenceBackground.imageUrl && <img className="design-page__fallback-preview" src={referenceBackground.imageUrl} alt="Подложка Gameplay editor" />}
                <div className="design-page__inline-actions"><Button onClick={() => void referenceBackground.upload()}>{referenceBackground.imageUrl ? "Заменить" : "Загрузить"}</Button>{referenceBackground.imageUrl && <Button onClick={() => void referenceBackground.remove()}>Удалить</Button>}</div>
                {referenceBackground.imageUrl && <label className="design-page__field"><span>Прозрачность ({Math.round(referenceBackground.opacity * 100)}%)</span><Slider min={0.1} max={1} step={0.05} value={referenceBackground.opacity} onChange={(event) => referenceBackground.setOpacity(Number(event.target.value))} /></label>}
                {referenceBackground.error && <p className="app__error">{referenceBackground.error}</p>}
                <p className="design-page__hint">Локальная подложка только для редактора. В OBS она не отображается.</p>
              </div>
              <WidgetSettings
                title="Текущий MMR"
                widget={layout.scenes.gameplay.widgets.session}
                onChange={(patch) => updateWidget("session", patch)}
              />
              <WidgetSettings
                title="История матчей"
                widget={layout.scenes.gameplay.widgets.recentMatches}
                onChange={(patch) => updateWidget("recentMatches", patch)}
              />
              <div className="design-page__widget-settings">
                <h3>Защита миникарты</h3>
                <Checkbox label="Показывать" checked={layout.scenes.gameplay.minimapCover.enabled} onChange={(event) => updateMinimap({ enabled: event.target.checked })} />
                <label className="design-page__field"><span>Сторона</span><Select value={layout.scenes.gameplay.minimapCover.anchor.endsWith("right") ? "right" : "left"} onChange={(event) => updateMinimap({ anchor: event.target.value === "right" ? "bottom-right" : "bottom-left", x: 0, y: 0 })}><option value="left">Слева</option><option value="right">Справа</option></Select></label>
                <label className="design-page__field"><span>Размер</span><Select value={layout.scenes.gameplay.minimapCover.size > MINIMAP_SIZE.normal ? "large" : "normal"} onChange={(event) => updateMinimap({ size: MINIMAP_SIZE[event.target.value as keyof typeof MINIMAP_SIZE], x: 0, y: 0 })}><option value="normal">Обычный</option><option value="large">Большой</option></Select></label>
              </div>
              <div className="design-page__widget-settings">
                <h3>Камера в OBS</h3>
                <Checkbox label="Показывать область в редакторе" checked={layout.scenes.gameplay.cameraZone.enabled} onChange={(event) => setLayout({ ...layout, scenes: { ...layout.scenes, gameplay: { ...layout.scenes.gameplay, cameraZone: { ...layout.scenes.gameplay.cameraZone, enabled: event.target.checked } } } })} />
                <p className="design-page__hint">Перетащите рамку камеры или измените её размер за угол. Это направляющая редактора; Companion не меняет transform источника камеры в OBS.</p>
                <Button onClick={() => setLayout({ ...layout, scenes: { ...layout.scenes, gameplay: { ...layout.scenes.gameplay, cameraZone: { enabled: true, anchor: "bottom-right", x: 1860, y: 1013, width: 400, height: 300 } } } })}>Сбросить положение</Button>
              </div>
              <div className="design-page__actions">
                <Button variant="primary" onClick={() => void handleSave()} disabled={saving}>
                  {saving ? "Сохранение…" : "Сохранить"}
                </Button>
                {savedFlash && <span className="design-page__saved">Сохранено ✓</span>}
              </div>
            </>
          )}

          {!loading && tab === "draft" && layout && (
            <>
              <div className="design-page__widget-settings">
                <h3>Защита драфта</h3>
                <label className="design-page__field"><span>Режим</span><Select value={layout.draftProtection.mode} onChange={(event) => setLayout({ ...layout, draftProtection: { ...layout.draftProtection, mode: event.target.value as "off" | "cover" } })}><option value="off">Без защиты</option><option value="cover">Полная заглушка</option></Select></label>
                <Checkbox label="Показывать свой текст" checked={layout.draftProtection.text.visible} onChange={(event) => updateDraftText({ visible: event.target.checked })} />
                <label className="design-page__field"><span>Текст</span><Input value={layout.draftProtection.text.content} onChange={(event) => updateDraftText({ content: event.target.value })} /></label>
                <p className="design-page__hint">Текст перемещается и масштабируется рамкой прямо в предпросмотре.</p>
              </div>
              <div className="design-page__actions"><Button variant="primary" onClick={() => void handleSave()} disabled={saving}>{saving ? "Сохранение…" : "Сохранить"}</Button>{savedFlash && <span className="design-page__saved">Сохранено ✓</span>}</div>
            </>
          )}

          {!loading && tab === "betweenMatches" && queueSettings && (
            <>
              <div className="design-page__widget-settings"><h3>Канал и контент</h3>
                <span className="design-page__field">Fallback для Live Capture</span>
                {queueSettings.webcamImageUrl && <img className="design-page__fallback-preview" src={queueSettings.webcamImageUrl.startsWith("/") ? `https://prereborn.ru${queueSettings.webcamImageUrl}` : queueSettings.webcamImageUrl} alt="Предпросмотр fallback Live Capture" />}
                <div className="design-page__inline-actions"><Button onClick={() => void chooseWebcamFallback()}>{queueSettings.webcamImageUrl ? "Заменить изображение" : "Выбрать изображение"}</Button>{queueSettings.webcamImageUrl && <Button onClick={() => void removeWebcamFallback()}>Удалить</Button>}</div>
                <label className="design-page__field"><span>Последних игр ({queueSettings.widgets.recentGamesLimit})</span><Slider min={1} max={15} step={1} value={queueSettings.widgets.recentGamesLimit} onChange={(event) => setQueueSettings({ ...queueSettings, widgets: { ...queueSettings.widgets, recentGamesLimit: Number(event.target.value) } })} /></label>
                <Checkbox label="Цель по рейтингу" checked={queueSettings.channelGoal.type === "rating"} onChange={(event) => {
                  const startValue = currentMmr ?? queueSettings.channelGoal.startValue;
                  setQueueSettings({ ...queueSettings, channelGoal: event.target.checked ? { type: "rating", label: "RATING GOAL", startValue, targetValue: startValue + 300 } : { ...queueSettings.channelGoal, type: "none" } });
                }} />
                {queueSettings.channelGoal.type === "rating" && <>
                  <label className="design-page__field"><span>Стартовый MMR</span><Input type="number" min={0} value={queueSettings.channelGoal.startValue} onChange={(event) => setQueueSettings({ ...queueSettings, channelGoal: { ...queueSettings.channelGoal, startValue: Number(event.target.value) } })} /></label>
                  <label className="design-page__field"><span>Текущий MMR</span><Input type="number" value={currentMmr ?? ""} disabled /></label>
                  <label className="design-page__field"><span>Целевой MMR</span><Input type="number" min={0} value={queueSettings.channelGoal.targetValue} onChange={(event) => setQueueSettings({ ...queueSettings, channelGoal: { ...queueSettings.channelGoal, targetValue: Number(event.target.value) } })} /></label>
                </>}
                <p className="design-page__hint">Избранные герои выбираются в разделе «Герои» (до трёх). Социальные ссылки сохраняются в существующих настройках аккаунта.</p>
                <p className="design-page__hint">Twitch Chat, Recent Followers и DonationAlerts используют подключённые интеграции аккаунта и обновляются в локальном OBS renderer.</p>
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
