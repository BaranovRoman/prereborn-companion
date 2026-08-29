import { useState } from "react";
import { Button } from "../components/ui";
import { ItemSoundModal } from "../components/sounds/ItemSoundModal";
import { ItemsGrid } from "../components/sounds/ItemsGrid";
import type { useGameSoundEngine } from "../sounds/useGameSoundEngine";
import type { GameSoundEventKind, TrackedItem } from "../services/dotaCompanionApi";

interface Props {
  engine: ReturnType<typeof useGameSoundEngine>;
  onGoToHeroes: () => void;
}

type Tab = "items" | "heroes";

// "Звуки" - Companion UI 2.0's Dota-inventory-inspired section (задача
// п.1-3), reachable from the WK-114 header's main nav. Not a copy of
// Valve's shop UI pixel-for-pixel and no new copyrighted assets bundled -
// item icons are hotlinked from Valve's own public Dota 2 CDN (see
// catalog.rs), the grid/panel chrome itself reuses this app's existing
// dark bevelled-panel language (.sounds-panel/.sound-tile tokens in
// App.css), not a new design system.
//
// WK-121 §9 - ownership after the Heroes move: hero-ability sound
// assignment now lives primarily on the hero's own page (Героя →
// способность → звук, see HeroDetailPage.tsx), reusing this exact same
// game-sound engine/commands. This screen no longer hosts a second,
// independent hero-ability UX (HeroesGrid/HeroAbilitiesModal, both
// removed) - the "Герои" tab is a redirect into that one real
// implementation, per the task's explicit "не поддерживать две
// независимые UX реализации". "Звуки" itself keeps ownership of
// non-hero events: items, and (per the section's reframed scope) the
// sound library/preview/delete machinery ItemSoundModal already provides.
export function SoundsPage({ engine, onGoToHeroes }: Props) {
  const [tab, setTab] = useState<Tab>("items");
  const [selectedItem, setSelectedItem] = useState<TrackedItem | null>(null);

  const { catalog, settings, error, setMaster, removeBinding, chooseAndBindFile, preview, stopPreview } = engine;

  const onChooseFile = async (eventId: string, kind: GameSoundEventKind) => {
    stopPreview();
    await chooseAndBindFile(eventId, kind);
  };

  if (!catalog || !settings) {
    return (
      <div className="page-heading">
        <span className="section-heading__eyebrow">Звуки</span>
        <h2>Звуки</h2>
        <p>Загрузка каталога…</p>
      </div>
    );
  }

  return (
    <div className="sounds-view">
      <div className="page-heading">
        <span className="section-heading__eyebrow">Звуки</span>
        <h2>Звуки</h2>
        <p>Выберите собственный звуковой файл для предметов и способностей — никаких встроенных звуков.</p>
      </div>

      <div className="sounds-panel">
        <div className="sounds-panel__master">
          <label className="sounds-panel__toggle">
            <input
              type="checkbox"
              checked={settings.enabled}
              onChange={(event) => void setMaster(event.target.checked, settings.masterVolume)}
            />
            Звуковые реакции
          </label>
          <div className="tts-volume sounds-panel__volume">
            <div className="tts-volume__row">
              <span>Громкость</span>
              <span className="tts-volume__value">{settings.masterVolume}%</span>
            </div>
            <input
              type="range"
              min={0}
              max={100}
              value={settings.masterVolume}
              disabled={!settings.enabled}
              onChange={(event) => void setMaster(settings.enabled, Number(event.target.value))}
            />
          </div>
        </div>
        {error && <p className="app__error">Ошибка: {error}</p>}

        <div className="mode-switch sounds-panel__tabs">
          <button className={tab === "items" ? "is-active" : ""} onClick={() => setTab("items")}>
            Предметы
          </button>
          <button className={tab === "heroes" ? "is-active" : ""} onClick={() => setTab("heroes")}>
            Герои
          </button>
        </div>

        {tab === "items" && (
          <ItemsGrid items={catalog.items} settings={settings} onSelect={(item) => setSelectedItem(item)} />
        )}
        {tab === "heroes" && (
          <div className="sounds-heroes-redirect">
            <p>
              Назначение звуков способностям теперь на странице героя: Герои → выбрать героя → способность → звук.
            </p>
            <Button variant="primary" onClick={onGoToHeroes}>Перейти в «Герои»</Button>
          </div>
        )}
      </div>

      {selectedItem && (
        <ItemSoundModal
          item={selectedItem}
          settings={settings}
          onClose={() => { stopPreview(); setSelectedItem(null); }}
          onChooseFile={onChooseFile}
          onPreview={(assetId) => preview(assetId, settings.masterVolume)}
          onRemove={removeBinding}
        />
      )}
    </div>
  );
}
