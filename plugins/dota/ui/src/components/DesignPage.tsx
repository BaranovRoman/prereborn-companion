import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { Button, Checkbox, Field, Input, RangeField, Select, Tabs } from "./ui";
import * as api from "../overlayApi";
import type { MinimapCoverSettings, OverlayAnchor, OverlayLayoutDoc, OverlayWidgetLayout, QueueSettingsDoc } from "../overlayTypes";
import { useGameplayReferenceBackground } from "../hooks/useGameplayReferenceBackground";
import { useLocalOverlayPreviewReady } from "../hooks/useLocalOverlayPreviewReady";

// Two scenes, matching OBS: a draft is shown inside Between Matches.
type DesignTab = "betweenMatches" | "gameplay";

const TABS: { key: DesignTab; label: string }[] = [
  { key: "betweenMatches", label: "Между матчами" },
  { key: "gameplay", label: "Игра" },
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
// Inspector width bounds for the preview/inspector splitter.
const INSPECTOR_MIN = 280;
const INSPECTOR_MAX = 560;
// Dragging stores exact fractions; the fields show one decimal.
const tenth = (value: number) => Math.round(value * 10) / 10;

// An uploaded image that may be gone (deleted file, offline host): say so
// instead of leaving a broken-image icon.
function PreviewImage({ src, alt }: { src: string; alt: string }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  if (failed) return <p className="design-page__image-error" role="status">Изображение не загрузилось. Выберите файл заново.</p>;
  return <img className="design-page__fallback-preview" src={src} alt={alt} onError={() => setFailed(true)} />;
}

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
      <Field label="Привязка">
        <Select value={widget.anchor} onChange={(event) => onChange({ anchor: event.target.value as OverlayAnchor })}>
          {ANCHOR_OPTIONS.map((anchor) => (
            <option key={anchor} value={anchor}>{ANCHOR_LABEL[anchor]}</option>
          ))}
        </Select>
      </Field>
      <div className="ui-field">
        <span className="ui-field__label">Масштаб</span>
        <div className="design-page__scale">
          <RangeField aria-label={`Масштаб: ${title}`} display={`${Math.round(widget.scale * 100)}%`} min={0.5} max={2} step={0.05} value={widget.scale} onChange={(event) => onChange({ scale: Number(event.target.value) })} />
          <Button size="small" variant="ghost" disabled={widget.scale === 1} onClick={() => onChange({ scale: 1 })} title="Вернуть масштаб 100%">1×</Button>
        </div>
      </div>
      <div className="design-page__widget-position">
        <Field label="X, %">
          <Input type="number" min={0} max={100} step={0.1} value={tenth(widget.xVw)} onChange={(event) => onChange({ xVw: Number(event.target.value) })} />
        </Field>
        <Field label="Y, %">
          <Input type="number" min={0} max={100} step={0.1} value={tenth(widget.yVh)} onChange={(event) => onChange({ yVh: Number(event.target.value) })} />
        </Field>
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
  const preview = useLocalOverlayPreviewReady(tab);
  const [pending,setPending]=useState<Awaited<ReturnType<typeof api.pendingSettings>>>(null);
  // Session-only: the sandboxed package frame has no storage of its own.
  const [inspectorWidth, setInspectorWidth] = useState(340);
  const workspace = useRef<HTMLDivElement>(null);
  const clampWidth = (value: number) => Math.min(INSPECTOR_MAX, Math.max(INSPECTOR_MIN, Math.round(value)));
  const startResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const handle = event.currentTarget;
    handle.setPointerCapture?.(event.pointerId);
    const move = (moveEvent: PointerEvent) => {
      const right = workspace.current?.getBoundingClientRect().right ?? window.innerWidth;
      setInspectorWidth(clampWidth(right - moveEvent.clientX));
    };
    const stop = () => { handle.removeEventListener("pointermove", move); handle.removeEventListener("pointerup", stop); handle.removeEventListener("pointercancel", stop); };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", stop);
    handle.addEventListener("pointercancel", stop);
  };
  const resizeByKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowLeft") { event.preventDefault(); setInspectorWidth((w) => clampWidth(w + 20)); }
    if (event.key === "ArrowRight") { event.preventDefault(); setInspectorWidth((w) => clampWidth(w - 20)); }
  };

  useEffect(() => {
    let cancelled = false;
    api.getOverlayLayout()
      .then(async(data) => { if (!cancelled) setLayout(data);const queue=await api.getQueueSettings();if(!cancelled)setQueueSettings(queue); })
      .catch((cause) => { if (!cancelled) setError(String(cause)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => { let disposed=false;void api.pendingSettings().then(value=>{if(!disposed)setPending(value);}).catch(e=>{if(!disposed)setError(String(e));});return()=>{disposed=true;}; }, []);
  useEffect(() => { api.getLocalSessionSummary().then((summary) => setCurrentMmr(summary.ratingCurrent)).catch(e => {if(!String(e).includes("not_prepared"))setError(String(e));}); }, []);

  useEffect(() => {
    const receive = (event: MessageEvent) => {
      const frame = document.querySelector<HTMLIFrameElement>(".design-page__preview");
      if (event.source !== frame?.contentWindow) return;
      if (event.data?.type === "prereborn-overlay-widget-change") {
        const { scene, widget, patch } = event.data;
        if (scene !== "gameplay" || !["session", "recentMatches"].includes(widget) || !patch) return;
        const sceneKey = "gameplay" as const;
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

  const handleSave = async () => {
    if (!layout || saving || pending) return;
    setSaving(true);
    setError(null);
    try {
      const saved = await api.saveOverlayLayout(layout);
      setLayout(saved);
      if (queueSettings) setQueueSettings(await api.saveQueueSettings(queueSettings));
      setSavedFlash(true);
    } catch (cause) {
      setError(String(cause));
      try{setPending(await api.pendingSettings());}catch(recovery){setError(`${String(cause)}; ${String(recovery)}`);}
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
      <div className="design-page__header">
        <div>
          <h3>Редактор оформления</h3>
          <p>Предпросмотр — тот же локальный оверлей, что видит OBS, с сохранёнными настройками. На сцене «Игра» элементы можно перетаскивать мышью.</p>
        </div>
        <Tabs items={TABS} active={tab} onChange={setTab} aria-label="Сцена оформления" />
      </div>

        {preview.ready&&preview.error&&<div className="ui-notice ui-notice--danger" role="alert"><span className="ui-notice__body">{preview.error}</span><Button size="small" onClick={preview.retry}>Повторить загрузку renderer</Button></div>}
        {pending&&<section className="ui-notice ui-notice--warning" role="alert"><p>Результат сохранения не подтверждён. Изменение не повторяется автоматически.</p><Button size="small" disabled={saving} onClick={()=>{void(async()=>{setSaving(true);setError(null);try{await api.reconcileSettings(pending);setPending(null);setLayout(await api.getOverlayLayout());setQueueSettings(await api.getQueueSettings());}catch(e){setError(String(e));}finally{setSaving(false);}})();}}>Проверить сохранённое состояние</Button></section>}
      <div className="design-page__workspace" ref={workspace} style={{ gridTemplateColumns: `minmax(0, 1fr) 12px ${inspectorWidth}px` }}>
        <div className="design-page__preview-column">
        <div className="design-page__preview-frame">
          {preview.ready ? (
            <iframe
              key={`${tab}:${preview.instance}`}
              className="design-page__preview"
              sandbox="allow-scripts"
              referrerPolicy="no-referrer"
              src={`http://127.0.0.1:3666/overlay?previewScene=${tab}&editor=1`}
              onLoad={(event) => event.currentTarget.contentWindow?.postMessage({ type: "prereborn-overlay-layout-preview", layout, queueSettings, referenceBackground: tab === "gameplay" && referenceBackground.imageUrl ? { url: referenceBackground.imageUrl, opacity: referenceBackground.opacity } : null }, "*")}
              title="Предпросмотр локального оверлея"
            />
          ) : (
            <div className="design-page__preview-placeholder">
              {preview.error ? (
                <>
                  <p className="ui-text-danger">{preview.error}</p>
                  <Button size="small" onClick={preview.retry}>Повторить</Button>
                </>
              ) : (
                <p className="ui-text-muted">Ожидаем локальный оверлей…</p>
              )}
            </div>
          )}
        </div>
        <p className="design-page__hint">1920 × 1080 · масштаб предпросмотра подстраивается под ширину. Перетащите разделитель справа, чтобы изменить ширину панели настроек.</p>
        </div>
        <div
          className="design-page__splitter"
          role="separator"
          aria-orientation="vertical"
          aria-label="Ширина панели настроек"
          aria-valuemin={INSPECTOR_MIN}
          aria-valuemax={INSPECTOR_MAX}
          aria-valuenow={inspectorWidth}
          tabIndex={0}
          onPointerDown={startResize}
          onKeyDown={resizeByKey}
          onDoubleClick={() => setInspectorWidth(340)}
        />

        <aside className="design-page__inspector" aria-label="Настройки оформления">
          {loading && <p className="ui-text-muted">Загрузка…</p>}

          {!loading && tab === "gameplay" && layout && (
            <>
              <div className="design-page__widget-settings">
                <h3>Скриншот Dota</h3>
                {referenceBackground.imageUrl && <PreviewImage src={referenceBackground.imageUrl} alt="Подложка Gameplay editor" />}
                <div className="design-page__inline-actions"><Button size="small" onClick={() => void referenceBackground.upload()}>{referenceBackground.imageUrl ? "Заменить" : "Загрузить"}</Button>{referenceBackground.imageUrl && <Button size="small" variant="danger" onClick={() => void referenceBackground.remove()}>Удалить</Button>}</div>
                {referenceBackground.imageUrl && <div className="ui-field"><span className="ui-field__label">Прозрачность</span><RangeField aria-label="Прозрачность подложки" display={`${Math.round(referenceBackground.opacity * 100)}%`} min={0.1} max={1} step={0.05} value={referenceBackground.opacity} onChange={(event) => referenceBackground.setOpacity(Number(event.target.value))} /></div>}
                {referenceBackground.error && <p className="ui-text-danger">{referenceBackground.error}</p>}
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
                <Field label="Сторона"><Select value={layout.scenes.gameplay.minimapCover.anchor.endsWith("right") ? "right" : "left"} onChange={(event) => updateMinimap({ anchor: event.target.value === "right" ? "bottom-right" : "bottom-left", x: 0, y: 0 })}><option value="left">Слева</option><option value="right">Справа</option></Select></Field>
                <Field label="Размер"><Select value={layout.scenes.gameplay.minimapCover.size > MINIMAP_SIZE.normal ? "large" : "normal"} onChange={(event) => updateMinimap({ size: MINIMAP_SIZE[event.target.value as keyof typeof MINIMAP_SIZE], x: 0, y: 0 })}><option value="normal">Обычный</option><option value="large">Большой</option></Select></Field>
              </div>
              <div className="design-page__widget-settings">
                <h3>Камера в OBS</h3>
                <Checkbox label="Показывать область в редакторе" checked={layout.scenes.gameplay.cameraZone.enabled} onChange={(event) => setLayout({ ...layout, scenes: { ...layout.scenes, gameplay: { ...layout.scenes.gameplay, cameraZone: { ...layout.scenes.gameplay.cameraZone, enabled: event.target.checked } } } })} />
                <p className="design-page__hint">Перетащите рамку камеры или измените её размер за угол. Это направляющая редактора; Companion не меняет transform источника камеры в OBS.</p>
                <div><Button size="small" variant="ghost" onClick={() => setLayout({ ...layout, scenes: { ...layout.scenes, gameplay: { ...layout.scenes.gameplay, cameraZone: { enabled: true, anchor: "bottom-right", x: 1860, y: 1013, width: 400, height: 300 } } } })}>Сбросить положение</Button></div>
              </div>
              <div className="design-page__actions">
                <Button variant="primary" onClick={() => void handleSave()} disabled={saving||!!pending}>
                  {saving ? "Сохранение…" : "Сохранить"}
                </Button>
                {savedFlash && <span className="design-page__saved">Сохранено ✓</span>}
              </div>
            </>
          )}

          {!loading && tab === "betweenMatches" && queueSettings && (
            <>
              <div className="design-page__widget-settings"><h3>Канал и контент</h3>
                <span className="ui-field__label">Заглушка для Live Capture</span>
                {queueSettings.webcamImageUrl && <PreviewImage src={queueSettings.webcamImageUrl.startsWith("/") ? `https://prereborn.ru${queueSettings.webcamImageUrl}` : queueSettings.webcamImageUrl} alt="Предпросмотр fallback Live Capture" />}
                <div className="design-page__inline-actions"><Button size="small" onClick={() => void chooseWebcamFallback()}>{queueSettings.webcamImageUrl ? "Заменить изображение" : "Выбрать изображение"}</Button>{queueSettings.webcamImageUrl && <Button size="small" variant="danger" onClick={() => void removeWebcamFallback()}>Удалить</Button>}</div>
                <div className="ui-field"><span className="ui-field__label">Последних игр</span><RangeField aria-label="Последних игр" display={String(queueSettings.widgets.recentGamesLimit)} min={1} max={15} step={1} value={queueSettings.widgets.recentGamesLimit} onChange={(event) => setQueueSettings({ ...queueSettings, widgets: { ...queueSettings.widgets, recentGamesLimit: Number(event.target.value) } })} /></div>
                <Checkbox label="Цель по рейтингу" checked={queueSettings.channelGoal.type === "rating"} onChange={(event) => {
                  const startValue = currentMmr ?? queueSettings.channelGoal.startValue;
                  setQueueSettings({ ...queueSettings, channelGoal: event.target.checked ? { type: "rating", label: "RATING GOAL", startValue, targetValue: startValue + 300 } : { ...queueSettings.channelGoal, type: "none" } });
                }} />
                {queueSettings.channelGoal.type === "rating" && <>
                  <div className="design-page__goal">
                    <Field label="Старт"><Input type="number" min={0} value={queueSettings.channelGoal.startValue} onChange={(event) => setQueueSettings({ ...queueSettings, channelGoal: { ...queueSettings.channelGoal, startValue: Number(event.target.value) } })} /></Field>
                    <Field label="Сейчас"><Input type="number" value={currentMmr ?? ""} readOnly /></Field>
                    <Field label="Цель"><Input type="number" min={0} value={queueSettings.channelGoal.targetValue} onChange={(event) => setQueueSettings({ ...queueSettings, channelGoal: { ...queueSettings.channelGoal, targetValue: Number(event.target.value) } })} /></Field>
                  </div>
                </>}
                <p className="design-page__hint">Избранные герои выбираются в разделе «Герои» (до трёх). Социальные ссылки сохраняются в существующих настройках аккаунта.</p>
                <p className="design-page__hint">Twitch Chat, Recent Followers и DonationAlerts используют подключённые интеграции аккаунта и обновляются в локальном OBS renderer.</p>
              </div>
              <div className="design-page__actions"><Button variant="primary" onClick={() => void handleSave()} disabled={saving||!!pending}>{saving ? "Сохранение…" : "Сохранить"}</Button>{savedFlash && <span className="design-page__saved">Сохранено ✓</span>}</div>
            </>
          )}

          {error && <p className="ui-notice ui-notice--danger" role="alert">Ошибка: {error}</p>}
        </aside>
      </div>
    </div>
  );
}
