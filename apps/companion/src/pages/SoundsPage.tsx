import { Checkbox, Slider, Tabs } from "../components/ui";
import { ItemsCatalog } from "../components/sounds/ItemsCatalog";
import type { useGameSoundEngine } from "../sounds/useGameSoundEngine";
import type { GameSoundEventKind } from "../services/dotaCompanionApi";

interface Props {
  engine: ReturnType<typeof useGameSoundEngine>;
}

const TABS = [{ key: "items" as const, label: "Предметы" }];
// §15 - "Библиотека" (uploaded files, reuse/delete) is deferred scope, not
// built this slice - see the research doc. Keeping the tab list as an
// array (rather than a single hardcoded heading) is what makes adding it
// later a one-line change instead of a restructure.

// "Звуки" - Companion UI 2.0's Dota-inventory-inspired section (задача
// п.1-3), reachable from the WK-114 header's main nav. Not a copy of
// Valve's shop UI pixel-for-pixel and no new copyrighted assets bundled -
// item icons are hotlinked from Valve's own public Dota 2 CDN (see
// catalog.rs), the grid/panel chrome itself reuses this app's existing
// dark bevelled-panel language (.sounds-panel/.sound-tile tokens in
// App.css), not a new design system.
//
// WK-122 §12 - the "Герои" tab (a redirect into the real Heroes section,
// per WK-121) is gone entirely, not just hidden - hero-ability sound
// assignment lives exclusively on the hero's own page now (Герои → герой →
// способность → звук, see HeroDetailPage.tsx), reusing this exact same
// game-sound engine/commands. "Звуки" keeps ownership of non-hero events
// only: the items catalog (see ItemsCatalog.tsx for §13/§14's master/detail
// rebuild) and, later, the sound library (§15).
export function SoundsPage({ engine }: Props) {
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
          <Checkbox
            className="sounds-panel__toggle"
            label="Звуковые реакции"
            checked={settings.enabled}
            onChange={(event) => void setMaster(event.target.checked, settings.masterVolume)}
          />
          <div className="tts-volume sounds-panel__volume">
            <div className="tts-volume__row">
              <span>Громкость</span>
              <span className="tts-volume__value">{settings.masterVolume}%</span>
            </div>
            <Slider
              min={0}
              max={100}
              value={settings.masterVolume}
              disabled={!settings.enabled}
              onChange={(event) => void setMaster(settings.enabled, Number(event.target.value))}
              aria-label="Громкость"
            />
          </div>
        </div>
        {error && <p className="app__error">Ошибка: {error}</p>}

        <Tabs items={TABS} active="items" onChange={() => {}} aria-label="Разделы звуков" />

        <ItemsCatalog
          items={catalog.items}
          settings={settings}
          onChooseFile={onChooseFile}
          onPreview={(assetId) => preview(assetId, settings.masterVolume)}
          onRemove={removeBinding}
        />
      </div>
    </div>
  );
}
