import { useState } from "react";
import { Tabs } from "../components/ui";

type DesignTab = "betweenMatches" | "draft" | "gameplay" | "postStream";

const TABS: { key: DesignTab; label: string }[] = [
  { key: "betweenMatches", label: "Между матчами" },
  { key: "draft", label: "Драфт" },
  { key: "gameplay", label: "Игра" },
  { key: "postStream", label: "Итоги" },
];

// WK-121 §15 - "Оформление" foundation/entry point. The full editor (drag/
// resize of overlay widgets) is out of scope for this slice - what ships
// here is the real navigation entry, the one-editor-shell layout, and a
// 16:9 preview frame wired to the SAME local overlay endpoint
// (127.0.0.1:3666/overlay) the real OBS Browser Source now uses (see
// docs/research/wk-121-companion-product-consolidation.md §1.6/§9) - not a
// second preview implementation, and not a fake "finished" editor: nothing
// here claims widget editing works yet.
export function DesignPage() {
  const [tab, setTab] = useState<DesignTab>("betweenMatches");

  return (
    <div className="design-page">
      <div className="page-heading">
        <span className="section-heading__eyebrow">Оформление</span>
        <h2>Оформление трансляции</h2>
        <p>
          Предпросмотр использует тот же локальный оверлей, что и OBS Browser Source
          (127.0.0.1:3666/overlay). Редактирование положения виджетов — в разработке.
        </p>
      </div>

      <Tabs items={TABS} active={tab} onChange={setTab} aria-label="Сцена оформления" />

      <div className="design-page__preview-frame">
        <iframe
          key={tab}
          className="design-page__preview"
          src="http://127.0.0.1:3666/overlay"
          title="Предпросмотр локального оверлея"
        />
      </div>

      <p className="design-page__hint">
        Сцена переключается автоматически по состоянию трансляции (GSI/OBS) — переключатель вкладок
        выше пока управляет только тем, что подписано на превью, не самой сценой оверлея.
      </p>
    </div>
  );
}
