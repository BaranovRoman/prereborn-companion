import { useEffect, useState } from "react";
import { SoundBindingRow } from "../components/sounds/SoundBindingRow";
import { Badge } from "../components/ui";
import type { useFavoriteHeroes } from "../hooks/useFavoriteHeroes";
import type { GameSoundEventKind, GameSoundSettings, TrackedAbility, TrackedHero } from "../services/dotaCompanionApi";
import { getHeroById } from "../services/heroCatalog";

interface Props {
  heroId: number;
  favorites: ReturnType<typeof useFavoriteHeroes>;
  trackedHero: TrackedHero | null;
  settings: GameSoundSettings | null;
  onBack: () => void;
  onChooseFile: (eventId: string, kind: GameSoundEventKind) => Promise<void>;
  onPreview: (assetId: string) => Promise<void>;
  onRemove: (eventId: string) => Promise<void>;
  stopPreview: () => void;
}

const ATTRIBUTE_LABEL: Record<string, string> = {
  strength: "Сила",
  agility: "Ловкость",
  intelligence: "Интеллект",
  universal: "Универсальный",
};

// WK-125 - past this many abilities a single vertical column starts running
// noticeably taller than the hero visual next to it (Invoker's 14 is the
// production example) - the list switches to a compact 2-column grid. A
// plain count threshold, not a hero id: any current or future hero with
// this many abilities gets the same treatment, and an ordinary hero (4-8
// abilities - Techies, Largo) always stays a single column, per this
// slice's "не Invoker-specific CSS" requirement.
const DENSE_ABILITY_LIST_THRESHOLD = 8;

function statusLabel(ability: TrackedAbility): string {
  if (ability.status === "unsupported") return `${ability.displayName}: ${ability.reason}`;
  if (ability.status === "experimental") return `${ability.displayName} (экспериментально): ${ability.reason}`;
  return ability.displayName;
}

interface AbilityListProps {
  abilities: TrackedAbility[];
  settings: GameSoundSettings;
  selectedAbilityId: string | null;
  onSelect: (id: string | null) => void;
  onChooseFile: Props["onChooseFile"];
  onPreview: Props["onPreview"];
  onRemove: Props["onRemove"];
}

// Each row surfaces the full assignment state up front (icon, name, support
// state, bound file) - only the three action buttons (Выбрать/Прослушать/
// Удалить) stay behind a single click, via the same inline SoundBindingRow
// HeroDetailPage always used (no modal).
function AbilityList({ abilities, settings, selectedAbilityId, onSelect, onChooseFile, onPreview, onRemove }: AbilityListProps) {
  const dense = abilities.length > DENSE_ABILITY_LIST_THRESHOLD;
  return (
    <div className={`hero-ability-list ${dense ? "hero-ability-list--dense" : ""}`}>
      {abilities.map((ability) => {
        const binding = settings.bindings.find((b) => b.eventId === ability.id && b.kind === "abilityCast");
        const asset = binding ? settings.assets.find((a) => a.id === binding.assetId) : undefined;
        const disabled = ability.status === "unsupported";
        const isSelected = ability.id === selectedAbilityId;

        let stateLabel: string;
        if (ability.status === "unsupported") stateLabel = "Недоступно";
        else if (binding) stateLabel = asset ? asset.originalName : "Звук назначен";
        else if (ability.status === "experimental") stateLabel = "Экспериментально";
        else stateLabel = "Звук не назначен";

        return (
          <div key={ability.id} className="hero-ability-item">
            <button
              type="button"
              className={[
                "hero-ability-row",
                `hero-ability-row--${ability.status}`,
                binding ? "hero-ability-row--bound" : "",
                isSelected ? "hero-ability-row--selected" : "",
              ].filter(Boolean).join(" ")}
              disabled={disabled}
              title={statusLabel(ability)}
              onClick={() => onSelect(isSelected ? null : ability.id)}
            >
              <img className="hero-ability-row__icon" src={ability.iconUrl} alt="" width={40} height={40} />
              <span className="hero-ability-row__meta">
                <span className="hero-ability-row__name">{ability.displayName}</span>
                <span className="hero-ability-row__state">{stateLabel}</span>
              </span>
              {ability.status === "experimental" && <span className="hero-ability-row__flag" aria-hidden="true">?</span>}
              {binding && <span className="hero-ability-row__bound-dot" aria-hidden="true" />}
            </button>
            {isSelected && (
              <SoundBindingRow
                eventId={ability.id}
                kind="abilityCast"
                masterVolume={settings.masterVolume}
                binding={binding}
                assets={settings.assets}
                onChooseFile={onChooseFile}
                onPreview={onPreview}
                onRemove={onRemove}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

// WK-125 - production visual review of WK-123's three-column layout
// ([left abilities] [hero] [right abilities], spanning the full workspace
// width) found abilities reading as two independent columns pinned to the
// window's edges, with the hero visual stranded alone in a wide gap between
// them - especially on ordinary 4-ability heroes, where each side column
// only had 2 rows to show. Rebuilt as ONE compact composition instead:
// [hero visual] [ability list], centered together as a single flex group
// (`.hero-detail__workspace`'s `justify-content: center` centers the PAIR,
// not each side independently) - since the ability list only ever extends
// to the visual's right, the hero itself reads as sitting slightly left of
// the workspace's true center, which is the effect this slice asked for
// without any extra offset math. The ability list is one ordered array
// again (no more artificial left/right split of a single hero's abilities)
// and only grows into a 2-column grid past DENSE_ABILITY_LIST_THRESHOLD -
// see AbilityList above.
export function HeroDetailPage({ heroId, favorites, trackedHero, settings, onBack, onChooseFile, onPreview, onRemove, stopPreview }: Props) {
  const [selectedAbilityId, setSelectedAbilityId] = useState<string | null>(null);
  const [videoFailed, setVideoFailed] = useState(false);

  // WK-132 - a preview started here must not keep playing after the user
  // navigates away, whether via the back button or by switching to another
  // section entirely (both just unmount this component - there's no shared
  // "leaving" event besides that). onChooseFile already stops a *running*
  // preview before importing a new file; this covers plain navigation.
  useEffect(() => stopPreview, [stopPreview]);

  const hero = getHeroById(heroId);
  if (!hero) {
    return (
      <div className="hero-detail">
        <button className="ui-button ui-button--ghost hero-detail__back" onClick={onBack}>← Герои</button>
        <p className="app__error">Герой не найден.</p>
      </div>
    );
  }

  const isFavorite = favorites.heroIds.includes(hero.id);
  const abilities = trackedHero?.abilities ?? [];

  return (
    <div className="hero-detail">
      <div className="hero-detail__topbar">
        <button className="ui-button ui-button--ghost hero-detail__back" onClick={onBack}>← Герои</button>
        <div className="hero-detail__identity">
          <h2>{hero.localizedName}</h2>
          <button
            type="button"
            className={`hero-detail__favorite ${isFavorite ? "is-active" : ""}`}
            aria-label={isFavorite ? "Убрать из избранного" : "Добавить в избранное"}
            disabled={favorites.busyId === hero.id}
            onClick={() => void favorites.toggle(hero.id)}
          >
            ★
          </button>
          <Badge tone="gold">{ATTRIBUTE_LABEL[hero.attribute]}</Badge>
        </div>
      </div>
      {favorites.error && <p className="app__error">Ошибка: {favorites.error}</p>}

      <h3 className="ui-settings-group__title">Способности</h3>
      {settings && !settings.enabled && (
        // WK-132 §27 - the page stays fully usable (assign/preview/remove
        // all still work, see SoundBindingRow) - this is just an honest
        // heads-up that live in-match playback is currently muted globally,
        // not a blocking banner and not a second toggle (the real one lives
        // in Sounds → Звуки).
        <p className="hero-detail__sounds-disabled-hint">
          Звуковые реакции выключены глобально — способности всё ещё можно назначать и прослушивать здесь, но во время матча они звучать не будут, пока их не включат в «Звуки».
        </p>
      )}
      {!trackedHero || !settings ? (
        <p className="heroes-grid__empty">Загрузка каталога звуков…</p>
      ) : (
        <div className="hero-detail__workspace">
          <div className="hero-detail__visual">
            {!videoFailed ? (
              <video
                key={hero.videoUrl}
                src={hero.videoUrl}
                poster={hero.portraitUrl}
                muted
                autoPlay
                loop
                playsInline
                onError={() => setVideoFailed(true)}
              />
            ) : (
              <img src={hero.portraitUrl} alt="" />
            )}
          </div>

          <AbilityList
            abilities={abilities}
            settings={settings}
            selectedAbilityId={selectedAbilityId}
            onSelect={setSelectedAbilityId}
            onChooseFile={onChooseFile}
            onPreview={onPreview}
            onRemove={onRemove}
          />
        </div>
      )}
    </div>
  );
}
